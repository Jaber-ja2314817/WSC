// Session ledger: per-session summaries, timelines and usage for the live dashboard.
// Pure — no Electron, Node or DOM imports. Consumes StationEvents and TranscriptExtras only.
// Privacy: timeline text comes from logText() and redacted tool summaries; nothing else.
import {
  tokenTotal,
  type DashStatus,
  type DashboardOptions,
  type DashboardSnapshot,
  type SessionSummary,
  type SubagentSummary,
  type TimelineKind,
  type TimelineStep,
  type TokenUsage,
  type TranscriptExtras,
} from './dashboardTypes';
import { logText } from './store';
import { ORCHESTRATOR_ID, agentKey } from './types';
import type { AgentState, AgentStatus, StationEvent, StationSnapshot } from './types';
import { UsageBook, computeUsageStats, costFor } from './usage';

export const DEFAULT_TIMELINE_CAP = 300;
export const DEFAULT_SESSION_HORIZON_MS = 24 * 3_600_000;
export const DEFAULT_MAX_SESSIONS = 30;
const SEEN_CAP = 5_000;
/** Hook and transcript copies of one prompt / turn end land within this of each other. */
export const COLLAPSE_MS = 10_000;
/** A store `waiting` older than this is an abandoned session (killed terminal, no SessionEnd). */
export const WAITING_CAP_MS = 24 * 3_600_000;
const COLLAPSE_KINDS = new Set<TimelineKind>(['prompt', 'turn_end']);

const READ_TOOLS = new Set(['Read']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const RUN_TOOLS = new Set(['Bash', 'PowerShell']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const DELEGATE_TOOLS = new Set(['Task', 'Agent']);

/** Input for describeStep(). Tool fields must already be sanitized (redact.ts). */
export interface StepInput {
  status: DashStatus;
  /** Waiting because the turn ended ("Your turn") rather than a question/permission. */
  turnEnded?: boolean;
  tool?: { name: string; summary?: string; label?: string };
  /** Consecutive Read starts in the current turn, ending with this tool. */
  readCount?: number;
}

/** Short human text for a session's current step, e.g. "Editing app.ts". */
export function describeStep(s: StepInput): string {
  switch (s.status) {
    case 'ended':
      return 'Ended';
    case 'idle':
      return 'Idle';
    case 'waiting':
      return s.turnEnded ? 'Your turn' : 'Waiting for you';
    default:
      break;
  }
  const t = s.tool;
  if (!t) return 'Thinking';
  const sum = t.summary;
  const verb = (v: string): string => (sum ? `${v} ${sum}` : v);
  if (READ_TOOLS.has(t.name)) {
    return (s.readCount ?? 1) > 1 ? `Reading ${s.readCount} files` : verb('Reading');
  }
  if (EDIT_TOOLS.has(t.name)) return verb('Editing');
  if (RUN_TOOLS.has(t.name)) return verb('Running');
  if (SEARCH_TOOLS.has(t.name)) return verb('Searching');
  if (WEB_TOOLS.has(t.name)) return verb('Browsing');
  if (DELEGATE_TOOLS.has(t.name)) return `Spawned ${t.label ?? sum ?? 'agent'}`;
  if (t.name.startsWith('mcp__')) return sum ?? t.name;
  return sum ? `${t.name} ${sum}` : t.name;
}

type TurnState = 'busy' | 'turn_end' | 'waiting';

interface Step extends TimelineStep {
  /** Who reported it; a hook step and a transcript step of the same moment collapse into one. */
  source?: string;
  /** Already collapsed with its twin from the other source. */
  merged?: boolean;
  useId?: string;
  readCount?: number;
  toolName?: string;
  toolSummary?: string;
  label?: string;
}

interface LedgerAgent {
  id: string;
  label: string;
  status: AgentStatus;
  statusTs: number;
  spawnedAt: number;
  lastEventAt: number;
  toolCalls: number;
  /** Consecutive Read starts in the current turn. */
  readRun: number;
  /** Became active after its last "finished" step, so another finish is a new hand-back. */
  activeSinceDone: boolean;
}

interface LedgerSession {
  id: string;
  projectId?: string;
  projectName?: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  gitBranch?: string;
  gitBranchTs: number;
  promptPreview?: string;
  promptPreviewTs: number;
  models: Set<string>;
  seen: Set<string>;
  steps: Step[];
  stepsByUse: Map<string, Step>;
  /** tool_end results that arrived before their tool_start. */
  pendingOk: Map<string, boolean>;
  agents: Map<string, LedgerAgent>;
  turn?: TurnState;
  turnTs: number;
  /** The turn state a compaction interrupted, restored when it finishes. */
  preCompactTurn?: TurnState;
  lastBusyAt: number;
  lastToolStep?: Step;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export class SessionLedger {
  readonly usageBook = new UsageBook();
  private readonly timelineCap: number;
  private readonly sessions = new Map<string, LedgerSession>();

  constructor(opts: { timelineCap?: number } = {}) {
    const cap = opts.timelineCap;
    this.timelineCap = cap !== undefined && cap > 0 ? Math.floor(cap) : DEFAULT_TIMELINE_CAP;
  }

  applyEvents(evs: StationEvent[]): boolean {
    let changed = false;
    for (const ev of evs) {
      try {
        changed = this.applyEvent(ev) || changed;
      } catch {
        // malformed event: skip
      }
    }
    return changed;
  }

  applyExtras(xs: TranscriptExtras[]): boolean {
    let changed = false;
    for (const x of xs) {
      try {
        changed = this.applyExtra(x) || changed;
      } catch {
        // malformed extras: skip
      }
    }
    return changed;
  }

  snapshot(station: StationSnapshot, opts: DashboardOptions): DashboardSnapshot {
    const { now } = opts;
    const horizon = opts.sessionHorizonMs ?? DEFAULT_SESSION_HORIZON_MS;
    const max = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const storeAgents = new Map<string, AgentState[]>();
    for (const a of Object.values(station?.agents ?? {})) {
      const list = storeAgents.get(a.sessionId);
      if (list) list.push(a);
      else storeAgents.set(a.sessionId, [a]);
    }

    const cards: SessionSummary[] = [];
    for (const s of this.sessions.values()) {
      const status = this.statusOf(s, station, storeAgents.get(s.id) ?? [], opts);
      const active = status === 'working' || status === 'waiting';
      if (!active && now - s.lastActivityAt > horizon) continue;
      cards.push(this.summarize(s, status, station, storeAgents.get(s.id) ?? [], opts));
    }
    const rank = (st: DashStatus): number => (st === 'working' || st === 'waiting' ? 0 : 1);
    cards.sort((a, b) => rank(a.status) - rank(b.status) || b.lastActivityAt - a.lastActivityAt);
    return {
      generatedAt: now,
      scanning: false,
      usage: computeUsageStats(this.usageBook, opts),
      sessions: cards.slice(0, Math.max(0, max)),
    };
  }

  /** Newest first. */
  timeline(sessionId: string, limit?: number): TimelineStep[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    const out: TimelineStep[] = [];
    const n = limit !== undefined && limit >= 0 ? Math.floor(limit) : s.steps.length;
    for (let i = s.steps.length - 1; i >= 0 && out.length < n; i--) {
      const st = s.steps[i];
      if (st) out.push(this.publicStep(s, st));
    }
    return out;
  }

  /** Drop usage records and sessions with no activity within `retentionMs`. */
  prune(now: number, retentionMs: number): void {
    const cutoff = now - retentionMs;
    for (const [id, s] of this.sessions) {
      if (s.lastActivityAt >= cutoff) continue;
      this.sessions.delete(id);
      this.usageBook.dropSession(id);
    }
    // A live session's card keeps its total even as its oldest records age out.
    this.usageBook.prune(cutoff, (id) => this.sessions.has(id));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private ensure(sessionId: string, ts: number, projectId?: string, projectName?: string) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        startedAt: ts,
        lastActivityAt: ts,
        gitBranchTs: Number.NEGATIVE_INFINITY,
        promptPreviewTs: Number.NEGATIVE_INFINITY,
        models: new Set(),
        seen: new Set(),
        steps: [],
        stepsByUse: new Map(),
        pendingOk: new Map(),
        agents: new Map(),
        turnTs: Number.NEGATIVE_INFINITY,
        lastBusyAt: Number.NEGATIVE_INFINITY,
      };
      this.sessions.set(sessionId, s);
    }
    // A session keeps the project it was first seen in (like the store).
    if (s.projectId === undefined && isStr(projectId)) {
      s.projectId = projectId;
      s.projectName = isStr(projectName) ? projectName : projectId;
    }
    s.startedAt = Math.min(s.startedAt, ts);
    s.lastActivityAt = Math.max(s.lastActivityAt, ts);
    return s;
  }

  private applyExtra(x: TranscriptExtras): boolean {
    if (!x || !isStr(x.sessionId) || !Number.isFinite(x.ts)) return false;
    const existing = this.sessions.get(x.sessionId);
    const before = existing
      ? `${existing.startedAt}|${existing.lastActivityAt}|${existing.projectId}`
      : '';
    const s = this.ensure(x.sessionId, x.ts, x.projectId, x.projectName);
    let changed = before !== `${s.startedAt}|${s.lastActivityAt}|${s.projectId}`;
    if (x.usage && this.usageBook.add([x.usage])) changed = true;
    if (isStr(x.model)) {
      if (!s.models.has(x.model)) {
        s.models.add(x.model);
        changed = true;
      }
      // Assistant output counts as busy activity (long generations between tool calls).
      if (x.ts > s.lastBusyAt) s.lastBusyAt = x.ts;
    }
    if (isStr(x.gitBranch) && x.ts >= s.gitBranchTs) {
      if (s.gitBranch !== x.gitBranch) changed = true;
      s.gitBranch = x.gitBranch;
      s.gitBranchTs = x.ts;
    }
    if (isStr(x.promptPreview) && x.ts >= s.promptPreviewTs) {
      if (s.promptPreview !== x.promptPreview) changed = true;
      s.promptPreview = x.promptPreview;
      s.promptPreviewTs = x.ts;
    }
    return changed;
  }

  private applyEvent(ev: StationEvent): boolean {
    if (!ev || typeof ev !== 'object') return false;
    if (!isStr(ev.id) || !isStr(ev.sessionId) || !isStr(ev.kind)) return false;
    if (!Number.isFinite(ev.ts)) return false;
    const known = this.sessions.get(ev.sessionId);
    const again = known?.seen.has(ev.id) === true;
    if (again && !this.finishesAgain(known, ev)) return false;
    const s = this.ensure(ev.sessionId, ev.ts, ev.projectId, ev.projectName);
    s.seen.add(ev.id);
    if (s.seen.size > SEEN_CAP) {
      const oldest = s.seen.values().next().value;
      if (oldest !== undefined) s.seen.delete(oldest);
    }

    const agentId = isStr(ev.agentId) ? ev.agentId : ORCHESTRATOR_ID;
    const isLead = agentId === ORCHESTRATOR_ID;
    const sub = isLead ? undefined : this.ensureAgent(s, agentId, ev);
    const lead = isLead ? this.ensureAgent(s, ORCHESTRATOR_ID, ev) : undefined;
    const agent = sub ?? lead;
    const setTurn = (t: TurnState): void => {
      if (ev.ts >= s.turnTs) {
        s.turn = t;
        s.turnTs = ev.ts;
        delete s.preCompactTurn;
      }
    };
    const busy = (): void => {
      if (ev.ts > s.lastBusyAt) s.lastBusyAt = ev.ts;
    };
    const setAgent = (status: AgentStatus): void => {
      if (agent && ev.ts >= agent.statusTs) {
        agent.status = status;
        agent.statusTs = ev.ts;
        // A tool result can land after the finish; only new work starts a new stretch.
        if (status !== 'done' && status !== 'error' && ev.kind !== 'tool_end') {
          agent.activeSinceDone = true;
        }
      }
    };
    const reopen = (): void => {
      if (s.endedAt !== undefined && ev.ts > s.endedAt) delete s.endedAt;
    };

    switch (ev.kind) {
      case 'session_start':
        reopen();
        this.addStep(s, ev, 'start', logText(ev));
        break;
      case 'session_end':
        s.endedAt = Math.max(s.endedAt ?? Number.NEGATIVE_INFINITY, ev.ts);
        this.addStep(s, ev, 'end', logText(ev));
        break;
      case 'user_prompt':
        reopen();
        busy();
        if (isLead) setTurn('busy');
        for (const a of s.agents.values()) a.readRun = 0;
        setAgent('thinking');
        this.addStep(s, ev, 'prompt', 'New prompt');
        break;
      case 'agent_spawn':
        reopen();
        busy();
        setAgent('thinking');
        if (!isLead) this.addStep(s, ev, 'subagent', logText(ev));
        break;
      case 'tool_start': {
        // Hooks race: a subagent's hand-back can land after its finish, and must not revive it.
        const lateFinal = ev.tool?.finalizing === true && agent?.status === 'done';
        if (!lateFinal) busy();
        if (isLead) setTurn('busy');
        if (agent) {
          agent.toolCalls++;
          if (!lateFinal) setAgent('working');
        }
        const name = ev.tool?.name ?? 'tool';
        let readCount: number | undefined;
        if (agent) {
          agent.readRun = READ_TOOLS.has(name) ? agent.readRun + 1 : 0;
          if (READ_TOOLS.has(name)) readCount = agent.readRun;
        }
        const step = this.addStep(s, ev, 'tool', logText(ev));
        step.toolName = name;
        if (ev.tool?.summary !== undefined) step.toolSummary = ev.tool.summary;
        if (ev.label !== undefined) step.label = ev.label;
        if (readCount !== undefined) step.readCount = readCount;
        const useId = ev.tool?.useId;
        if (useId !== undefined) {
          step.useId = useId;
          s.stepsByUse.set(useId, step);
          const ok = s.pendingOk.get(useId);
          if (ok !== undefined) {
            step.ok = ok;
            s.pendingOk.delete(useId);
          }
        }
        if (!s.lastToolStep || step.ts >= s.lastToolStep.ts) s.lastToolStep = step;
        break;
      }
      case 'tool_end': {
        busy();
        if (isLead) setTurn('busy');
        // A finished subagent stays done: its hand-back call's result lands after agent_finish.
        if (isLead || agent?.status !== 'done') setAgent('thinking');
        const useId = ev.tool?.useId;
        const ok = ev.tool?.ok !== false;
        if (useId !== undefined) {
          const step = s.stepsByUse.get(useId);
          if (step) step.ok = ok;
          else if (s.pendingOk.size < this.timelineCap) s.pendingOk.set(useId, ok);
        }
        break;
      }
      case 'waiting_for_user':
        setTurn('waiting');
        setAgent('waiting');
        this.addStep(s, ev, 'wait', logText(ev));
        break;
      case 'agent_finish': {
        setAgent('done');
        // One step per stretch of work, however many copies of the finish arrive.
        if (isLead || !agent?.activeSinceDone) break;
        const step = this.addStep(s, ev, 'subagent_done', logText(ev));
        // One lifecycle id per agent: a later hand-back's step still needs its own key.
        if (again) step.id = `${ev.id}:${ev.ts}`;
        if (agent) agent.activeSinceDone = false;
        break;
      }
      case 'agent_error':
        setAgent('error');
        if (isLead) setTurn('turn_end');
        this.addStep(s, ev, 'error', logText(ev));
        break;
      case 'compacting':
        busy();
        if (isLead) {
          const interrupted = s.turn !== 'busy' ? s.turn : s.preCompactTurn;
          setTurn('busy');
          if (interrupted) s.preCompactTurn = interrupted;
        }
        setAgent('thinking');
        this.addStep(s, ev, 'compact', logText(ev));
        break;
      case 'idle':
        if (ev.idleReason === 'compact') {
          // Not a turn end: mid-turn stays busy, and a compaction between turns goes back.
          if (isLead && s.preCompactTurn && ev.ts >= s.turnTs) setTurn(s.preCompactTurn);
          break;
        }
        setAgent('idle');
        if (isLead) {
          setTurn('turn_end');
          this.addStep(s, ev, 'turn_end', 'Turn finished');
        }
        break;
      default:
        break;
    }
    return true;
  }

  /**
   * Lifecycle ids are fixed per agent, so a resumed subagent's next finish repeats one. It still
   * counts while the agent isn't finished; the twin of a finish that landed changes nothing.
   */
  private finishesAgain(s: LedgerSession | undefined, ev: StationEvent): boolean {
    if (ev.kind !== 'agent_finish' || !isStr(ev.agentId) || ev.agentId === ORCHESTRATOR_ID) {
      return false;
    }
    const a = s?.agents.get(ev.agentId);
    return !!a && a.status !== 'done' && a.status !== 'error';
  }

  private ensureAgent(s: LedgerSession, id: string, ev: StationEvent): LedgerAgent {
    let a = s.agents.get(id);
    if (!a) {
      a = {
        id,
        label: id === ORCHESTRATOR_ID ? 'orchestrator' : 'agent',
        status: id === ORCHESTRATOR_ID ? 'idle' : 'thinking',
        statusTs: Number.NEGATIVE_INFINITY,
        spawnedAt: ev.ts,
        lastEventAt: ev.ts,
        toolCalls: 0,
        readRun: 0,
        activeSinceDone: true,
      };
      s.agents.set(id, a);
    }
    // Lead-agent delegate calls carry the *subagent's* label; only label subagents from events.
    if (
      id !== ORCHESTRATOR_ID &&
      isStr(ev.label) &&
      (a.label === 'agent' || ev.kind === 'agent_spawn')
    ) {
      a.label = ev.label;
    }
    a.spawnedAt = Math.min(a.spawnedAt, ev.ts);
    a.lastEventAt = Math.max(a.lastEventAt, ev.ts);
    return a;
  }

  private addStep(s: LedgerSession, ev: StationEvent, kind: TimelineKind, text: string): Step {
    const agentId = isStr(ev.agentId) ? ev.agentId : ORCHESTRATOR_ID;
    if (agentId === ORCHESTRATOR_ID && COLLAPSE_KINDS.has(kind)) {
      const dup = this.findTwin(s, kind, ev.ts, ev.source);
      if (dup) {
        // Hook and transcript reported the same moment with different ids: keep one step.
        dup.merged = true;
        if (ev.source === 'transcript') dup.text = text;
        if (ev.ts < dup.ts) {
          s.steps.splice(s.steps.indexOf(dup), 1);
          dup.ts = ev.ts;
          this.insertStep(s, dup);
        }
        return dup;
      }
    }
    const step: Step = { id: ev.id, ts: ev.ts, kind, agentId, text };
    if (isStr(ev.source)) step.source = ev.source;
    this.insertStep(s, step);
    return step;
  }

  /**
   * The other source's report of the same moment: the nearest unmerged orchestrator step of
   * the same kind within ±COLLAPSE_MS of `ts`. Two steps from one source are two real turns.
   */
  private findTwin(
    s: LedgerSession,
    kind: TimelineKind,
    ts: number,
    source: unknown,
  ): Step | undefined {
    let best: Step | undefined;
    for (let i = s.steps.length - 1; i >= 0; i--) {
      const st = s.steps[i];
      if (!st) continue;
      if (st.ts < ts - COLLAPSE_MS) break;
      if (st.ts > ts + COLLAPSE_MS) continue;
      if (st.kind !== kind || st.agentId !== ORCHESTRATOR_ID || st.merged) continue;
      if (st.source !== undefined && st.source === source) continue;
      if (!best || Math.abs(st.ts - ts) < Math.abs(best.ts - ts)) best = st;
    }
    return best;
  }

  private insertStep(s: LedgerSession, step: Step): void {
    // Keep ts order even when events arrive out of order (stable for equal ts).
    let i = s.steps.length;
    while (i > 0 && (s.steps[i - 1]?.ts ?? 0) > step.ts) i--;
    s.steps.splice(i, 0, step);
    if (s.steps.length > this.timelineCap) {
      const [dropped] = s.steps.splice(this.evictionIndex(s), 1);
      if (dropped?.useId !== undefined && s.stepsByUse.get(dropped.useId) === dropped) {
        s.stepsByUse.delete(dropped.useId);
      }
    }
  }

  /** A workflow's subagents would flood the lead out, so its steps keep up to half the cap. */
  private evictionIndex(s: LedgerSession): number {
    let lead = 0;
    let oldestSub = -1;
    s.steps.forEach((st, i) => {
      if (st.agentId === ORCHESTRATOR_ID) lead++;
      else if (oldestSub < 0) oldestSub = i;
    });
    return oldestSub >= 0 && lead < this.timelineCap / 2 ? oldestSub : 0;
  }

  private publicStep(s: LedgerSession, st: Step): TimelineStep {
    const out: TimelineStep = {
      id: st.id,
      ts: st.ts,
      kind: st.kind,
      agentId: st.agentId,
      text: st.text,
    };
    if (st.agentId !== ORCHESTRATOR_ID) out.agentLabel = s.agents.get(st.agentId)?.label ?? 'agent';
    if (st.ok !== undefined) out.ok = st.ok;
    return out;
  }

  private ended(s: LedgerSession, station: StationSnapshot): number | undefined {
    const storeEnded = station?.sessions?.[s.id]?.endedAt;
    if (storeEnded !== undefined) return storeEnded;
    return s.endedAt;
  }

  private statusOf(
    s: LedgerSession,
    station: StationSnapshot,
    agents: AgentState[],
    opts: DashboardOptions,
  ): DashStatus {
    if (this.ended(s, station) !== undefined) return 'ended';
    const silent = opts.now - s.lastActivityAt;
    const quiet = silent >= opts.idleMs;
    const abandoned = silent >= WAITING_CAP_MS;
    if (station?.sessions?.[s.id] && agents.length > 0) {
      let waiting = false;
      let busy = false;
      for (const a of agents) {
        if (a.status === 'waiting') waiting = true;
        else if (a.status === 'working' || a.status === 'thinking') busy = true;
        else if (a.status === 'stale' && !quiet) busy = true;
      }
      if (waiting && !abandoned) return 'waiting';
      if (busy) return 'working';
    }
    if (quiet || abandoned) return 'idle';
    if (s.turn === 'turn_end' || s.turn === 'waiting') return 'waiting';
    if (opts.now - s.lastBusyAt < opts.idleMs) return 'working';
    return 'idle';
  }

  private summarize(
    s: LedgerSession,
    status: DashStatus,
    station: StationSnapshot,
    agents: AgentState[],
    opts: DashboardOptions,
  ): SessionSummary {
    const byModel = this.usageBook.sessionByModel(s.id);
    const ranked = Object.entries(byModel).sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]));
    const models = ranked.map(([m]) => m);
    for (const m of s.models) if (!models.includes(m)) models.push(m);
    const usage: TokenUsage = this.usageBook.sessionUsage(s.id);

    const subagents: SubagentSummary[] = [];
    let toolCalls = 0;
    const subs = [...s.agents.values()].sort((a, b) => a.spawnedAt - b.spawnedAt);
    for (const a of subs) {
      toolCalls += a.toolCalls;
      if (a.id === ORCHESTRATOR_ID) continue;
      subagents.push({
        id: a.id,
        label: a.label,
        status: this.subStatus(s, a, station, status, opts),
        toolCalls: a.toolCalls,
      });
    }

    const endedAt = this.ended(s, station);
    const summary: SessionSummary = {
      id: s.id,
      shortId: s.id.slice(0, 8),
      projectId: s.projectId ?? 'unknown',
      projectName: s.projectName ?? 'unknown',
      models,
      startedAt: s.startedAt,
      lastActivityAt: s.lastActivityAt,
      status,
      currentStep: describeStep(this.stepInput(s, status, agents)),
      subagents,
      toolCalls,
      usage,
    };
    if (s.gitBranch !== undefined) summary.gitBranch = s.gitBranch;
    if (endedAt !== undefined) summary.endedAt = endedAt;
    if (s.promptPreview !== undefined && opts.showPromptPreview !== false) {
      summary.promptPreview = s.promptPreview;
    }
    if (ranked.length > 1) summary.usageByModel = byModel;
    const cost = costFor(byModel, opts.prices);
    if (cost !== undefined) summary.costUsd = cost;
    return summary;
  }

  private subStatus(
    s: LedgerSession,
    a: LedgerAgent,
    station: StationSnapshot,
    sessionStatus: DashStatus,
    opts: DashboardOptions,
  ): AgentStatus {
    const stored = station?.agents?.[agentKey(s.id, a.id)];
    if (stored) return stored.status;
    if (a.status === 'done' || a.status === 'error') return a.status;
    if (sessionStatus === 'ended') return 'done';
    if (
      (a.status === 'working' || a.status === 'thinking') &&
      opts.now - a.lastEventAt >= opts.idleMs
    ) {
      return 'stale';
    }
    return a.status;
  }

  private stepInput(s: LedgerSession, status: DashStatus, agents: AgentState[]): StepInput {
    if (status !== 'working') {
      const waitingInStore = agents.some((a) => a.status === 'waiting');
      return { status, turnEnded: !waitingInStore && s.turn === 'turn_end' };
    }
    // The busiest store agent: the most recently started tool, else thinking.
    let best: AgentState | undefined;
    for (const a of agents) {
      if ((a.status !== 'working' && a.status !== 'stale') || !a.currentTool) continue;
      if (!best || a.stepStartedAt > best.stepStartedAt) best = a;
    }
    const cur = best?.currentTool;
    if (cur) {
      const step = cur.useId !== undefined ? s.stepsByUse.get(cur.useId) : undefined;
      const tool: NonNullable<StepInput['tool']> = { name: cur.name };
      if (cur.summary !== undefined) tool.summary = cur.summary;
      const label = step?.label;
      if (label !== undefined) tool.label = label;
      return {
        status,
        tool,
        ...(step?.readCount !== undefined ? { readCount: step.readCount } : {}),
      };
    }
    if (agents.some((a) => a.status === 'thinking')) return { status };
    // Ledger only: the latest tool step, while the turn is still running.
    const last = s.lastToolStep;
    if (last && last.ts >= s.turnTs && last.toolName !== undefined) {
      const tool: NonNullable<StepInput['tool']> = { name: last.toolName };
      if (last.toolSummary !== undefined) tool.summary = last.toolSummary;
      if (last.label !== undefined) tool.label = last.label;
      return {
        status,
        tool,
        ...(last.readCount !== undefined ? { readCount: last.readCount } : {}),
      };
    }
    return { status };
  }
}
