// State store: projects → sessions → agents, driven only by StationEvents.
// Pure TypeScript — no Electron, Node or DOM imports. Never throws on odd input.
import {
  ORCHESTRATOR_ID,
  agentKey,
  type AgentState,
  type AgentStatus,
  type LogEntry,
  type ProjectState,
  type SessionState,
  type StationEvent,
  type StationSnapshot,
} from './types';

export interface StationStoreOptions {
  /** Max activity-log entries kept (oldest dropped). */
  logCap?: number;
  /** Working/thinking agents with no events for this long become 'stale'. */
  staleMs?: number;
  /** Ended sessions (and their agents) are removed after this long. */
  sessionLingerMs?: number;
  /** Max remembered event ids for dedupe. */
  dedupeCap?: number;
}

type CurrentTool = NonNullable<AgentState['currentTool']>;

/** Per-agent bookkeeping that isn't part of the public snapshot. */
interface AgentMeta {
  /** ts of the last applied status-changing event; older events never regress status. */
  statusTs: number;
  /** Recently ended tool use ids, so a late tool_start doesn't resurrect them. */
  endedUseIds: string[];
}

const ENDED_USE_IDS_CAP = 64;

export class StationStore {
  private readonly logCap: number;
  private readonly staleMs: number;
  private readonly sessionLingerMs: number;
  private readonly dedupeCap: number;

  private readonly projects = new Map<string, ProjectState>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly agents = new Map<string, AgentState>();
  private readonly meta = new Map<string, AgentMeta>();
  /** Removed sessions → their end ts; late events at or before it are ignored. */
  private readonly removedSessions = new Map<string, number>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private log: LogEntry[] = [];
  private eventsReceived = 0;
  private projectCounter = 0;

  constructor(opts: StationStoreOptions = {}) {
    this.logCap = opts.logCap ?? 2000;
    this.staleMs = opts.staleMs ?? 90_000;
    this.sessionLingerMs = opts.sessionLingerMs ?? 10_000;
    this.dedupeCap = opts.dedupeCap ?? 20_000;
  }

  apply(ev: StationEvent): boolean {
    const changed = this.applyOne(ev);
    if (changed) this.emit();
    return changed;
  }

  applyMany(evs: StationEvent[]): boolean {
    let changed = false;
    for (const ev of evs) changed = this.applyOne(ev) || changed;
    if (changed) this.emit();
    return changed;
  }

  tick(now: number): boolean {
    let changed = false;
    for (const agent of this.agents.values()) {
      if (
        (agent.status === 'working' || agent.status === 'thinking') &&
        now - agent.lastEventAt > this.staleMs
      ) {
        agent.status = 'stale';
        agent.stepStartedAt = now;
        changed = true;
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.endedAt !== undefined && now - session.endedAt > this.sessionLingerMs) {
        this.removeSession(session.id, session.endedAt);
        changed = true;
      }
    }
    if (changed) this.emit();
    return changed;
  }

  clearIdleProjects(now: number, idleMs: number): void {
    let changed = false;
    for (const project of [...this.projects.values()]) {
      if (now - project.lastEventAt <= idleMs) continue;
      for (const sid of [...project.sessionIds]) {
        const s = this.sessions.get(sid);
        this.removeSession(sid, s?.endedAt ?? s?.lastEventAt ?? now);
      }
      this.projects.delete(project.id);
      changed = true;
    }
    if (changed) this.emit();
  }

  snapshot(): StationSnapshot {
    return structuredClone({
      projects: Object.fromEntries(this.projects),
      sessions: Object.fromEntries(this.sessions),
      agents: Object.fromEntries(this.agents),
      log: this.log,
      eventsReceived: this.eventsReceived,
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a broken listener must not break the store
      }
    }
  }

  private applyOne(ev: StationEvent): boolean {
    try {
      return this.applyUnsafe(ev);
    } catch {
      return false;
    }
  }

  private applyUnsafe(raw: StationEvent): boolean {
    if (!raw || typeof raw !== 'object') return false;
    const { id, sessionId, projectId, kind } = raw;
    if (typeof id !== 'string' || !id) return false;
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof projectId !== 'string' || !projectId) return false;
    if (typeof kind !== 'string') return false;
    if (this.seen.has(id)) return false;

    const ev: StationEvent = {
      ...raw,
      ts: Number.isFinite(raw.ts) ? raw.ts : 0,
      agentId: typeof raw.agentId === 'string' && raw.agentId ? raw.agentId : ORCHESTRATOR_ID,
    };

    const removedAt = this.removedSessions.get(sessionId);
    if (removedAt !== undefined) {
      if (ev.ts <= removedAt) return false;
      this.removedSessions.delete(sessionId);
    }

    this.remember(id);
    const project = this.ensureProject(ev);
    const session = this.ensureSession(ev, project);
    const agent = this.ensureAgent(ev, session);

    this.applyKind(ev, session, agent);

    project.lastEventAt = Math.max(project.lastEventAt, ev.ts);
    session.lastEventAt = Math.max(session.lastEventAt, ev.ts);
    agent.lastEventAt = Math.max(agent.lastEventAt, ev.ts);
    this.eventsReceived++;
    this.appendLog(ev);
    return true;
  }

  private applyKind(ev: StationEvent, session: SessionState, agent: AgentState): void {
    const key = agentKey(agent.sessionId, agent.id);
    const tool = ev.tool;

    switch (ev.kind) {
      case 'session_start':
        if (session.endedAt !== undefined && ev.ts > session.endedAt) delete session.endedAt;
        this.setStatus(this.orchestratorOf(session), 'idle', ev.ts, undefined);
        break;

      case 'session_end':
        session.endedAt = Math.max(session.endedAt ?? 0, ev.ts);
        for (const aid of session.agentIds) {
          const a = this.agents.get(agentKey(session.id, aid));
          if (a && this.setStatus(a, 'done', ev.ts, undefined)) a.finishedAt = ev.ts;
        }
        break;

      case 'user_prompt':
        this.reopen(session, ev.ts);
        this.setStatus(agent, 'thinking', ev.ts, undefined);
        break;

      case 'agent_spawn':
        this.reopen(session, ev.ts);
        if (ev.label) agent.label = ev.label;
        if (ev.parentAgentId) agent.parentAgentId = ev.parentAgentId;
        agent.spawnedAt = Math.min(agent.spawnedAt, ev.ts);
        this.setStatus(agent, 'thinking', ev.ts, undefined);
        break;

      case 'tool_start': {
        agent.toolCalls++;
        const useId = tool?.useId;
        const alreadyEnded = useId !== undefined && this.metaOf(key).endedUseIds.includes(useId);
        if (tool && !alreadyEnded) {
          this.setStatus(agent, 'working', ev.ts, {
            name: tool.name,
            category: tool.category,
            ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
            ...(useId !== undefined ? { useId } : {}),
          });
        }
        break;
      }

      case 'tool_end': {
        const useId = tool?.useId;
        if (useId !== undefined) {
          const ended = this.metaOf(key).endedUseIds;
          ended.push(useId);
          if (ended.length > ENDED_USE_IDS_CAP) ended.shift();
        }
        const current = agent.currentTool;
        // Parallel tools: ending A while B is the current tool keeps B working.
        const endsCurrent = !current || current.useId === undefined || current.useId === useId;
        if (endsCurrent) this.setStatus(agent, 'thinking', ev.ts, undefined);
        break;
      }

      case 'waiting_for_user': {
        const waitTool: CurrentTool | undefined = tool
          ? {
              name: tool.name,
              category: tool.category,
              ...(tool.summary !== undefined ? { summary: tool.summary } : {}),
              ...(tool.useId !== undefined ? { useId: tool.useId } : {}),
            }
          : agent.currentTool;
        this.setStatus(agent, 'waiting', ev.ts, waitTool);
        break;
      }

      case 'agent_finish':
        if (this.setStatus(agent, 'done', ev.ts, undefined)) agent.finishedAt = ev.ts;
        break;

      case 'agent_error':
        if (this.setStatus(agent, 'error', ev.ts, undefined)) agent.finishedAt = ev.ts;
        break;

      case 'idle':
        this.setStatus(agent, 'idle', ev.ts, undefined);
        break;

      case 'compacting':
        this.setStatus(agent, 'thinking', ev.ts, undefined);
        break;

      default:
        // Unknown kinds still count as activity but change no status.
        break;
    }
  }

  /** Activity after a session ended (e.g. a resumed session) reopens it. */
  private reopen(session: SessionState, ts: number): void {
    if (session.endedAt !== undefined && ts > session.endedAt) delete session.endedAt;
  }

  /** Returns false (no change) when the event is older than the agent's last status change. */
  private setStatus(
    agent: AgentState,
    status: AgentStatus,
    ts: number,
    tool: CurrentTool | undefined,
  ): boolean {
    const m = this.metaOf(agentKey(agent.sessionId, agent.id));
    if (ts < m.statusTs) return false;
    m.statusTs = ts;
    const toolChanged =
      agent.currentTool?.name !== tool?.name ||
      agent.currentTool?.useId !== tool?.useId ||
      agent.currentTool?.summary !== tool?.summary;
    if (agent.status !== status || toolChanged) agent.stepStartedAt = ts;
    agent.status = status;
    if (tool) agent.currentTool = tool;
    else delete agent.currentTool;
    if (status !== 'done' && status !== 'error') delete agent.finishedAt;
    return true;
  }

  private metaOf(key: string): AgentMeta {
    let m = this.meta.get(key);
    if (!m) {
      m = { statusTs: Number.NEGATIVE_INFINITY, endedUseIds: [] };
      this.meta.set(key, m);
    }
    return m;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.dedupeCap) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }

  private ensureProject(ev: StationEvent): ProjectState {
    let p = this.projects.get(ev.projectId);
    if (!p) {
      p = {
        id: ev.projectId,
        name: ev.projectName || ev.projectId,
        order: this.projectCounter++,
        createdAt: ev.ts,
        lastEventAt: ev.ts,
        sessionIds: [],
      };
      this.projects.set(p.id, p);
    }
    return p;
  }

  private ensureSession(ev: StationEvent, project: ProjectState): SessionState {
    let s = this.sessions.get(ev.sessionId);
    if (!s) {
      s = {
        id: ev.sessionId,
        projectId: project.id,
        startedAt: ev.ts,
        lastEventAt: ev.ts,
        agentIds: [],
      };
      this.sessions.set(s.id, s);
      project.sessionIds.push(s.id);
      this.createAgent(s, ORCHESTRATOR_ID, ev.ts);
    }
    s.startedAt = Math.min(s.startedAt, ev.ts);
    return s;
  }

  private ensureAgent(ev: StationEvent, session: SessionState): AgentState {
    const existing = this.agents.get(agentKey(session.id, ev.agentId));
    if (existing) {
      if (ev.label && existing.label === 'agent') existing.label = ev.label;
      return existing;
    }
    const a = this.createAgent(session, ev.agentId, ev.ts);
    if (ev.label) a.label = ev.label;
    a.parentAgentId = ev.parentAgentId ?? ORCHESTRATOR_ID;
    return a;
  }

  private createAgent(session: SessionState, id: string, ts: number): AgentState {
    const isOrchestrator = id === ORCHESTRATOR_ID;
    const a: AgentState = {
      id,
      sessionId: session.id,
      projectId: session.projectId,
      isOrchestrator,
      label: isOrchestrator ? 'orchestrator' : 'agent',
      status: isOrchestrator ? 'idle' : 'thinking',
      stepStartedAt: ts,
      lastEventAt: ts,
      spawnedAt: ts,
      toolCalls: 0,
    };
    this.agents.set(agentKey(session.id, id), a);
    if (isOrchestrator) session.agentIds.unshift(id);
    else session.agentIds.push(id);
    return a;
  }

  private orchestratorOf(session: SessionState): AgentState {
    const key = agentKey(session.id, ORCHESTRATOR_ID);
    return this.agents.get(key) ?? this.createAgent(session, ORCHESTRATOR_ID, session.startedAt);
  }

  private removeSession(sessionId: string, endedAt: number): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const aid of s.agentIds) {
      const key = agentKey(sessionId, aid);
      this.agents.delete(key);
      this.meta.delete(key);
    }
    this.sessions.delete(sessionId);
    const p = this.projects.get(s.projectId);
    if (p) p.sessionIds = p.sessionIds.filter((id) => id !== sessionId);
    this.removedSessions.set(sessionId, endedAt);
  }

  private appendLog(ev: StationEvent): void {
    const entry: LogEntry = {
      id: ev.id,
      ts: ev.ts,
      projectId: ev.projectId,
      sessionId: ev.sessionId,
      agentId: ev.agentId,
      kind: ev.kind,
      text: logText(ev),
    };
    // Keep chronological order even when events arrive out of order.
    let i = this.log.length;
    while (i > 0 && (this.log[i - 1]?.ts ?? 0) > entry.ts) i--;
    this.log.splice(i, 0, entry);
    if (this.log.length > this.logCap) this.log.splice(0, this.log.length - this.logCap);
  }
}

/** Short human text. Uses only the already-sanitized tool summary — never raw input. */
export function logText(ev: StationEvent): string {
  const tool = ev.tool;
  const withSummary = (name: string): string =>
    tool?.summary ? `${name} · ${tool.summary}` : name;
  switch (ev.kind) {
    case 'session_start':
      return 'session started';
    case 'session_end':
      return 'session ended';
    case 'user_prompt':
      return 'new prompt';
    case 'agent_spawn':
      return `spawned ${ev.label ?? 'agent'}`;
    case 'agent_finish':
      return 'finished';
    case 'agent_error':
      return 'error';
    case 'tool_start':
      return tool ? withSummary(tool.name) : 'tool';
    case 'tool_end':
      return tool ? `${tool.name} ${tool.ok === false ? 'failed' : 'done'}` : 'tool done';
    case 'waiting_for_user':
      return tool ? `waiting for you · ${tool.name}` : 'waiting for you';
    case 'idle':
      return 'idle';
    case 'compacting':
      return 'compacting context';
    default:
      return 'event';
  }
}
