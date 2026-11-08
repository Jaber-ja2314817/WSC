// Crew director: turns store snapshots into choreography (brief §5.3, §6.0, §6.2).
// Pure TS — no Pixi/DOM — so it runs under Vitest. The scene draws the DirectorFrame it returns.
//
// Truth beats animation: status/tool/stepStartedAt on every CrewView mirror the latest snapshot
// immediately; walks are retargeted, sped up or snapped rather than lagging behind reality.
import { BUBBLE_PRIORITY, BubbleQueue } from '@shared/bubbles';
import type { Dir, Spot, StationLayout, TilePos } from '@shared/layoutTypes';
import {
  ORCHESTRATOR_ID,
  agentKey,
  type AgentState,
  type AgentStatus,
  type StationSnapshot,
  type ToolCategory,
} from '@shared/types';
import {
  DEFAULT_DIRECTOR_SETTINGS,
  type CrewAnim,
  type CrewPhase,
  type CrewView,
  type DirectorFrame,
  type DirectorSettings,
  type FindPath,
  type PhraseMoment,
  type ZoneStatusView,
} from './types';

export interface DirectorOptions {
  findPath: FindPath;
  phrases: (m: PhraseMoment) => readonly string[];
  settings?: Partial<DirectorSettings>;
  random?: () => number;
}

/** Where a bound crew member should be, derived from its agent's real status. */
type Intent =
  'desk' | 'report_done' | 'report_error' | 'report_waiting' | 'report_checkin' | 'lounge';

const ASSIGN_PAUSE_MS = 600;
const ARRIVE_FADE_MS = 400;
const REPORT_MS = 2000;
const CHECKIN_MS = 1500;
const LEAVE_FADE_MS = 500;
/** Walks longer than this are sped up so the station never lags behind reality. */
const MAX_WALK_MS = 4000;
/** More intent changes than this inside CHURN_WINDOW_MS → snap instead of walking. */
const CHURN_LIMIT = 3;
const CHURN_WINDOW_MS = 2000;
const CHATTY_EVERY = 5;
const LOUNGE_PHRASE_CHANCE = 0.5;

const CATEGORY_ANIM: Record<ToolCategory, CrewAnim> = {
  read: 'read',
  search: 'scan',
  write: 'type',
  execute: 'terminal',
  web: 'comms',
  delegate: 'report',
  plan: 'scan',
  mcp: 'terminal',
  other: 'type',
};

const CATEGORY_VERB: Record<ToolCategory, string> = {
  read: 'reading',
  search: 'searching',
  write: 'editing',
  execute: 'running',
  web: 'browsing',
  delegate: 'delegating',
  plan: 'planning',
  mcp: 'using',
  other: 'working on',
};

interface Sprite {
  id: string;
  variant: number;
  isOrchestrator: boolean;
  /** Lounge pool member (vs. an extra that arrived because the pool ran out). */
  pool: boolean;
  poolIndex: number;
  sessionId?: string;
  agentKey?: string;
  label: string;
  x: number;
  y: number;
  facing: Dir;
  phase: CrewPhase;
  phaseStartedAt: number;
  /** Timer for assigned/arriving/reporting phases. */
  phaseUntil?: number;
  intent?: Intent;
  /** Intent the current path was planned for; differs from intent → replan. */
  plannedIntent?: Intent;
  path: TilePos[];
  speed: number;
  dest?: Spot;
  alpha: number;
  alphaTarget: number;
  leaving: boolean;
  deskId?: string;
  projectId?: string;
  reportSpot?: number;
  toolCallsAtReport: number;
  intentChanges: number[];
  lastStatus?: AgentStatus;
  lastToolKey?: string;
  seat?: number;
}

const FREE_LABEL = (i: number): string => `crew ${i + 1}`;

export class Director {
  private settings: DirectorSettings;
  private findPath: FindPath;
  private readonly phrases: (m: PhraseMoment) => readonly string[];
  private readonly random: () => number;
  private layout: StationLayout | null = null;
  private snap: StationSnapshot | null = null;
  private sprites = new Map<string, Sprite>();
  private extraSeq = 0;
  private bubbles: BubbleQueue;
  private selected?: string;
  /** deskId → agentKey */
  private desks = new Map<string, string>();
  /** reportSpot index → sprite id */
  private reportSpots = new Map<number, string>();
  /** seat index → session id */
  private seats = new Map<number, string>();
  private now = 0;

  constructor(opts: DirectorOptions) {
    this.findPath = opts.findPath;
    this.phrases = opts.phrases;
    this.random = opts.random ?? Math.random;
    this.settings = { ...DEFAULT_DIRECTOR_SETTINGS, ...opts.settings };
    this.bubbles = new BubbleQueue({ ttlMs: this.settings.bubbleTtlMs });
  }

  /**
   * computeLayout translates the whole grid to fit, so adding or growing a zone can shift every
   * absolute tile coordinate. Positions relative to `center.rect` are stable, so all sprites,
   * paths and targets are offset by the center's delta; movers then replan on the new grid.
   * Pass the pathfinder for the new layout (e.g. `makePathfinder(layout)`) — they're per-layout.
   */
  setLayout(layout: StationLayout, findPath?: FindPath): void {
    if (findPath) this.findPath = findPath;
    const old = this.layout;
    const dx = old ? layout.center.rect.x - old.center.rect.x : 0;
    const dy = old ? layout.center.rect.y - old.center.rect.y : 0;
    this.lastLayoutShift = { dx, dy };
    this.layout = layout;
    for (const s of this.sprites.values()) {
      s.x += dx;
      s.y += dy;
      for (const p of s.path) {
        p.x += dx;
        p.y += dy;
      }
      if (s.dest) s.dest = { ...s.dest, tile: { x: s.dest.tile.x + dx, y: s.dest.tile.y + dy } };
      if (s.isOrchestrator) {
        this.placeOrchestrator(s);
      } else if (s.path.length > 0) {
        s.plannedIntent = undefined;
      } else if (s.phase === 'working' || s.phase === 'lounge_idle' || s.phase === 'reporting') {
        // At rest: make sure the spot still exists where we stand (e.g. a desk moved).
        const rest = this.restingSpot(s);
        if (rest && (rest.tile.x !== s.x || rest.tile.y !== s.y)) {
          // Crew walk to a desk that moved, so a growing room never makes them jump.
          if (s.phase === 'working' && s.intent === 'desk') s.plannedIntent = undefined;
          else this.snapTo(s, rest, false);
        }
      }
    }
    this.compactSeats();
    this.ensurePool(this.now);
  }

  /** Tile delta applied by the last setLayout (the scene offsets its camera by it). */
  lastLayoutShift = { dx: 0, dy: 0 };

  setSettings(partial: Partial<DirectorSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.bubbles.setTtl(this.settings.bubbleTtlMs);
    this.ensurePool(this.now);
  }

  select(key?: string): void {
    this.selected = key;
  }

  setSnapshot(snap: StationSnapshot, now: number): void {
    this.snap = snap;
    this.now = now;
    this.reconcile(now);
  }

  update(now: number, dtMs: number): DirectorFrame {
    this.now = now;
    if (!this.layout) return { crew: [], bubbles: [], zones: this.zoneViews(now) };
    this.ensurePool(now);
    for (const s of [...this.sprites.values()]) this.step(s, now, dtMs);
    return {
      crew: [...this.sprites.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((s) => this.view(s)),
      bubbles: this.bubbles.visible(now).map((b) => ({
        id: b.id,
        crewId: b.crewId,
        kind: b.kind,
        text: b.text,
        bornAt: b.bornAt,
        ttlMs: b.ttlMs,
        stack: b.stack,
      })),
      zones: this.zoneViews(now),
    };
  }

  // ---------------------------------------------------------------- reconcile

  private reconcile(now: number): void {
    const snap = this.snap;
    if (!snap) return;
    this.ensurePool(now);
    this.reconcileOrchestrators(snap, now);

    const bound = new Map<string, Sprite>();
    for (const s of this.sprites.values()) if (s.agentKey) bound.set(s.agentKey, s);

    // Agents gone from the snapshot (session removed) → back to the lounge.
    for (const [key, s] of bound) {
      if (!snap.agents[key]) this.setIntent(s, 'lounge', now);
    }

    const agents = Object.values(snap.agents)
      .filter((a) => !a.isOrchestrator)
      .sort((a, b) => a.spawnedAt - b.spawnedAt || a.id.localeCompare(b.id));
    for (const agent of agents) {
      const key = agentKey(agent.sessionId, agent.id);
      let s = bound.get(key);
      if (!s) {
        // Finished before we ever showed it: nothing to choreograph.
        if (agent.status === 'done' || agent.status === 'error') continue;
        s = this.bind(agent, key, now);
      }
      this.applyAgent(s, agent, now);
    }
  }

  private reconcileOrchestrators(snap: StationSnapshot, now: number): void {
    const sessions = Object.values(snap.sessions).sort(
      (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
    );
    const live = new Set(sessions.map((s) => s.id));
    for (const s of this.sprites.values()) {
      if (s.isOrchestrator && s.sessionId && !live.has(s.sessionId) && !s.leaving) {
        s.leaving = true;
        s.alphaTarget = 0;
        if (s.seat !== undefined && this.seats.get(s.seat) === s.sessionId) {
          this.seats.delete(s.seat);
        }
      }
    }
    for (const session of sessions) {
      const id = `orch:${session.id}`;
      let s = this.sprites.get(id);
      if (!s) {
        const seat = this.freeSeat(session.id);
        s = this.newSprite(id, seat * 3 + 1, now, {
          isOrchestrator: true,
          sessionId: session.id,
          projectId: session.projectId,
          seat,
          phase: 'seated',
        });
        this.placeOrchestrator(s);
      } else if (s.leaving) {
        this.reclaimSeat(s, session.id);
      }
      s.leaving = false;
      s.alphaTarget = 1;
      s.label = snap.projects[session.projectId]?.name ?? 'orchestrator';
      const agent = snap.agents[agentKey(session.id, ORCHESTRATOR_ID)];
      if (agent) this.orchestratorBubbles(s, agent, now);
    }
    this.compactSeats();
  }

  private bind(agent: AgentState, key: string, now: number): Sprite {
    const free = [...this.sprites.values()]
      .filter((s) => s.pool && !s.agentKey && !s.isOrchestrator)
      .sort((a, b) => a.poolIndex - b.poolIndex)[0];
    let s: Sprite;
    if (free) {
      s = free;
      s.phase = 'assigned';
      s.phaseStartedAt = now;
      s.phaseUntil = now + ASSIGN_PAUSE_MS;
      s.path = [];
      this.say(s, 'assigned', now);
    } else {
      // Pool exhausted: a new crew member arrives so every real agent is represented.
      // Its own id space: `crew-N` could still be a bound pool member after the lounge shrank.
      const seq = this.extraSeq++;
      const idx = this.settings.loungeSize + seq;
      s = this.newSprite(`extra-${seq}`, idx, now, { phase: 'arriving' });
      s.pool = false;
      s.poolIndex = idx;
      s.alpha = 0;
      s.phaseUntil = now + ARRIVE_FADE_MS;
      const arrival = this.layout?.center.arrival;
      if (arrival) {
        s.x = arrival.x;
        s.y = arrival.y;
      }
      this.say(s, 'arrive', now);
    }
    s.agentKey = key;
    s.sessionId = agent.sessionId;
    s.projectId = agent.projectId;
    s.label = agent.label;
    s.toolCallsAtReport = agent.toolCalls;
    s.lastStatus = undefined;
    s.lastToolKey = undefined;
    s.intent = 'desk';
    s.plannedIntent = undefined;
    return s;
  }

  private applyAgent(s: Sprite, agent: AgentState, now: number): void {
    s.label = agent.label;
    s.projectId = agent.projectId;
    const prev = s.lastStatus;
    const status = agent.status;

    // Status bubbles on tool changes.
    const tool = agent.currentTool;
    const toolKey = tool ? `${tool.useId ?? ''}|${tool.name}|${tool.summary ?? ''}` : undefined;
    if (toolKey && toolKey !== s.lastToolKey && status === 'working') {
      this.status(s, toolText(tool!.category, tool!.name, tool!.summary), now);
    }
    s.lastToolKey = toolKey;

    if (status !== prev) {
      if (status === 'done') this.say(s, 'done', now);
      else if (status === 'error') this.say(s, 'error', now, BUBBLE_PRIORITY.urgent);
      else if (status === 'waiting') {
        this.status(s, 'waiting for you', now, BUBBLE_PRIORITY.urgent);
        this.say(s, 'waiting', now);
      } else if (status === 'thinking' && (prev === undefined || prev === 'idle')) {
        this.status(s, 'thinking…', now, BUBBLE_PRIORITY.catchphrase);
      }
    }
    s.lastStatus = status;
    // The zone stops counting finished crew straight away, so their desk is free for the next
    // agent even while they are still off to report.
    if (status === 'done' || status === 'error') this.releaseDesk(s);

    let intent = this.intentFor(status);
    if (
      intent === 'desk' &&
      this.settings.reportFrequency === 'chatty' &&
      s.phase === 'working' &&
      agent.toolCalls - s.toolCallsAtReport >= CHATTY_EVERY
    ) {
      s.toolCallsAtReport = agent.toolCalls;
      intent = 'report_checkin';
    }
    // A check-in in progress finishes on its own timer.
    if (s.intent === 'report_checkin' && intent === 'desk') return;
    // Once reporting is finished the sprite heads to the lounge regardless of a still-'done' agent.
    if (s.intent === 'lounge' && (intent === 'report_done' || intent === 'lounge')) return;
    this.setIntent(s, intent, now);
  }

  private intentFor(status: AgentStatus): Intent {
    const freq = this.settings.reportFrequency;
    switch (status) {
      case 'done':
        return freq === 'minimal' ? 'lounge' : 'report_done';
      case 'error':
        return 'report_error';
      case 'waiting':
        return 'report_waiting';
      default:
        return 'desk';
    }
  }

  private setIntent(s: Sprite, intent: Intent, now: number): void {
    if (s.intent === intent) return;
    const was = s.intent;
    s.intent = intent;
    s.intentChanges = s.intentChanges.filter((t) => now - t < CHURN_WINDOW_MS);
    s.intentChanges.push(now);
    if (intent === 'lounge') this.unbind(s, now);
    if (was === 'report_waiting' && intent === 'desk') this.say(s, 'heading_out', now);
  }

  private unbind(s: Sprite, now: number): void {
    if (s.agentKey) this.releaseDesk(s);
    s.agentKey = undefined;
    s.sessionId = undefined;
    s.projectId = undefined;
    s.lastStatus = undefined;
    s.lastToolKey = undefined;
    s.label = s.pool ? FREE_LABEL(s.poolIndex) : 'crew';
    s.phaseStartedAt = now;
  }

  // -------------------------------------------------------------------- step

  private step(s: Sprite, now: number, dtMs: number): void {
    // Fades.
    if (s.alpha !== s.alphaTarget) {
      const d = dtMs / (s.leaving ? LEAVE_FADE_MS : ARRIVE_FADE_MS);
      s.alpha =
        s.alpha < s.alphaTarget
          ? Math.min(s.alphaTarget, s.alpha + d)
          : Math.max(s.alphaTarget, s.alpha - d);
    }
    if (s.leaving && s.alpha <= 0) {
      this.removeSprite(s);
      return;
    }
    if (s.isOrchestrator) return;

    if (s.phase === 'arriving' || s.phase === 'assigned') {
      if (s.phase === 'arriving') s.alphaTarget = 1;
      if (s.phaseUntil !== undefined && now < s.phaseUntil) return;
      s.phaseUntil = undefined;
      // Plans and leaves the phase; if the zone isn't laid out yet, retries next frame.
      this.plan(s, now);
    } else if (s.intent && (s.intent !== s.plannedIntent || this.deskFreedUp(s))) {
      this.plan(s, now);
    }

    if (s.path.length > 0) {
      this.move(s, dtMs);
      if (s.path.length === 0) this.arrive(s, now);
      return;
    }

    if (s.phase === 'reporting' && s.phaseUntil !== undefined && now >= s.phaseUntil) {
      s.phaseUntil = undefined;
      if (s.intent === 'report_checkin') this.setIntent(s, 'desk', now);
      else if (s.intent === 'report_done' || s.intent === 'report_error') {
        this.setIntent(s, 'lounge', now);
      }
    }
  }

  private plan(s: Sprite, now: number): void {
    const intent = s.intent;
    if (!intent) return;
    const dest = this.destinationFor(s, intent);
    if (!dest) return; // layout not ready for this zone yet; try again next frame
    s.plannedIntent = intent;
    if (!intent.startsWith('report')) this.releaseReportSpot(s);
    s.dest = dest;
    s.phase =
      intent === 'desk'
        ? 'walking_to_zone'
        : intent === 'lounge'
          ? 'walking_to_lounge'
          : 'walking_to_center';
    s.phaseStartedAt = now;

    const from = { x: Math.round(s.x), y: Math.round(s.y) };
    const atDest = from.x === dest.tile.x && from.y === dest.tile.y;
    const churn = s.intentChanges.filter((t) => now - t < CHURN_WINDOW_MS).length > CHURN_LIMIT;
    if (atDest) {
      s.x = dest.tile.x;
      s.y = dest.tile.y;
      s.path = [];
      this.arrive(s, now);
      return;
    }
    if (this.settings.reduceMotion) {
      this.snapTo(s, dest, false);
      this.arrive(s, now);
      return;
    }
    const path = churn ? null : this.findPath(from, dest.tile);
    if (!path || path.length === 0) {
      this.snapTo(s, dest, true);
      this.arrive(s, now);
      return;
    }
    s.x = from.x;
    s.y = from.y;
    s.path = path.map((p) => ({ x: p.x, y: p.y }));
    const walkMs = (s.path.length / this.settings.walkSpeed) * 1000;
    s.speed = walkMs > MAX_WALK_MS ? s.path.length / (MAX_WALK_MS / 1000) : this.settings.walkSpeed;
  }

  private move(s: Sprite, dtMs: number): void {
    let budget = (s.speed * dtMs) / 1000;
    while (budget > 0 && s.path.length > 0) {
      const next = s.path[0]!;
      const dx = next.x - s.x;
      const dy = next.y - s.y;
      const dist = Math.abs(dx) + Math.abs(dy);
      if (dist > 0)
        s.facing =
          Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      if (dist <= budget) {
        s.x = next.x;
        s.y = next.y;
        s.path.shift();
        budget -= dist;
      } else {
        s.x += (dx / dist) * budget;
        s.y += (dy / dist) * budget;
        budget = 0;
      }
    }
  }

  private arrive(s: Sprite, now: number): void {
    if (s.dest) s.facing = s.dest.facing;
    s.phaseStartedAt = now;
    switch (s.intent) {
      case 'desk':
        s.phase = 'working';
        break;
      case 'lounge':
        if (!s.pool) {
          s.leaving = true;
          s.alphaTarget = 0;
        }
        s.phase = 'lounge_idle';
        if (this.random() < LOUNGE_PHRASE_CHANCE) this.say(s, 'lounge', now);
        break;
      case 'report_checkin':
        s.phase = 'reporting';
        s.phaseUntil = now + CHECKIN_MS;
        break;
      case 'report_waiting':
        s.phase = 'reporting';
        s.phaseUntil = undefined;
        break;
      default:
        s.phase = 'reporting';
        s.phaseUntil = now + REPORT_MS;
    }
  }

  // ---------------------------------------------------------- destinations

  private destinationFor(s: Sprite, intent: Intent): Spot | null {
    const layout = this.layout;
    if (!layout) return null;
    if (intent === 'lounge') return this.restingSpot(s);
    if (intent === 'desk') return this.deskSeat(s);
    return this.reportSpot(s);
  }

  private restingSpot(s: Sprite): Spot | null {
    const layout = this.layout;
    if (!layout) return null;
    if (s.agentKey) {
      if (s.intent === 'desk') return this.deskSeat(s);
      if (s.intent?.startsWith('report')) return this.reportSpot(s);
    }
    if (!s.pool) return { id: 'arrival', tile: layout.center.arrival, facing: 'down' };
    const spots = layout.center.loungeSpots;
    if (spots.length === 0) return null;
    return spots[s.poolIndex % spots.length]!;
  }

  private deskSeat(s: Sprite): Spot | null {
    const layout = this.layout;
    if (!layout || !s.agentKey || !s.projectId) return null;
    const zone = layout.zones.find((z) => z.projectId === s.projectId);
    if (!zone) return null;
    let desk = s.deskId ? zone.desks.find((d) => d.id === s.deskId) : undefined;
    if (!desk) {
      if (s.deskId) this.releaseDesk(s);
      desk = zone.desks.find((d) => !this.desks.has(d.id));
      if (desk) {
        this.desks.set(desk.id, s.agentKey);
        s.deskId = desk.id;
      }
    }
    if (desk) return desk.seat;
    // More agents than desks: stand by the zone door until the layout grows.
    return { id: `${zone.projectId}:door`, tile: zone.door, facing: 'up' };
  }

  /** Standing by the door, or on the way there, and a seat has opened up. */
  private deskFreedUp(s: Sprite): boolean {
    if (s.intent !== 'desk' || s.deskId || !s.agentKey || !s.projectId) return false;
    const zone = this.layout?.zones.find((z) => z.projectId === s.projectId);
    return zone?.desks.some((d) => !this.desks.has(d.id)) ?? false;
  }

  private releaseDesk(s: Sprite): void {
    if (s.deskId && this.desks.get(s.deskId) === s.agentKey) this.desks.delete(s.deskId);
    s.deskId = undefined;
  }

  private reportSpot(s: Sprite): Spot | null {
    const spots = this.layout?.center.reportSpots ?? [];
    if (spots.length === 0) return null;
    if (s.reportSpot === undefined) {
      let idx = spots.findIndex((_, i) => !this.reportSpots.has(i));
      if (idx < 0) idx = s.poolIndex % spots.length;
      s.reportSpot = idx;
      this.reportSpots.set(idx, s.id);
    }
    return spots[s.reportSpot % spots.length]!;
  }

  private releaseReportSpot(s: Sprite): void {
    if (s.reportSpot !== undefined && this.reportSpots.get(s.reportSpot) === s.id) {
      this.reportSpots.delete(s.reportSpot);
    }
    s.reportSpot = undefined;
  }

  private freeSeat(sessionId: string): number {
    let i = 0;
    while (this.seats.has(i)) i++;
    this.seats.set(i, sessionId);
    return i;
  }

  /** A leaving orchestrator gave up its seat; a session that came back needs one again. */
  private reclaimSeat(s: Sprite, sessionId: string): void {
    if (s.seat !== undefined && !this.seats.has(s.seat)) this.seats.set(s.seat, sessionId);
    else s.seat = this.freeSeat(sessionId);
    this.placeOrchestrator(s);
  }

  /** Seats past the end of the table (it shrank) would wrap onto someone else's tile. */
  private compactSeats(): void {
    const count = this.layout?.center.tableSeats.length ?? 0;
    for (const s of this.sprites.values()) {
      if (!s.isOrchestrator || s.leaving || !s.sessionId) continue;
      if (s.seat === undefined || s.seat < count) continue;
      let free = 0;
      while (free < count && this.seats.has(free)) free++;
      if (free >= count) return; // more sessions than the station has room for
      this.seats.delete(s.seat);
      this.seats.set(free, s.sessionId);
      s.seat = free;
      this.placeOrchestrator(s);
    }
  }

  private placeOrchestrator(s: Sprite): void {
    const seats = this.layout?.center.tableSeats ?? [];
    if (seats.length === 0 || s.seat === undefined) return;
    const seat = seats[s.seat % seats.length]!;
    s.x = seat.tile.x;
    s.y = seat.tile.y;
    s.facing = seat.facing;
  }

  private snapTo(s: Sprite, spot: Spot, fade: boolean): void {
    s.x = spot.tile.x;
    s.y = spot.tile.y;
    s.facing = spot.facing;
    s.path = [];
    if (fade) s.alpha = Math.min(s.alpha, 0.3);
  }

  // ---------------------------------------------------------------- sprites

  private ensurePool(now: number): void {
    const want = this.settings.loungeSize;
    for (let i = 0; i < want; i++) {
      const id = `crew-${i}`;
      if (this.sprites.has(id)) continue;
      const s = this.newSprite(id, i, now, { phase: 'lounge_idle' });
      s.label = FREE_LABEL(i);
      const spot = this.restingSpot(s);
      if (spot) this.snapTo(s, spot, false);
    }
    // Shrink: drop free pool members beyond the new size.
    for (const s of [...this.sprites.values()]) {
      if (s.pool && !s.isOrchestrator && s.poolIndex >= want && !s.agentKey) this.removeSprite(s);
    }
  }

  private newSprite(
    id: string,
    variant: number,
    now: number,
    extra: Partial<Sprite> & { phase: CrewPhase },
  ): Sprite {
    const s: Sprite = {
      id,
      variant,
      isOrchestrator: false,
      pool: true,
      poolIndex: variant,
      label: '',
      x: 0,
      y: 0,
      facing: 'down',
      phaseStartedAt: now,
      path: [],
      speed: this.settings.walkSpeed,
      alpha: 1,
      alphaTarget: 1,
      leaving: false,
      toolCallsAtReport: 0,
      intentChanges: [],
      ...extra,
    };
    this.sprites.set(id, s);
    return s;
  }

  private removeSprite(s: Sprite): void {
    this.releaseDesk(s);
    this.releaseReportSpot(s);
    if (s.isOrchestrator && s.seat !== undefined && this.seats.get(s.seat) === s.sessionId) {
      this.seats.delete(s.seat);
    }
    this.sprites.delete(s.id);
    this.bubbles.clearCrew(s.id);
  }

  // ---------------------------------------------------------------- bubbles

  private orchestratorBubbles(s: Sprite, agent: AgentState, now: number): void {
    const tool = agent.currentTool;
    const toolKey = tool ? `${tool.useId ?? ''}|${tool.name}|${tool.summary ?? ''}` : undefined;
    if (toolKey && toolKey !== s.lastToolKey && agent.status === 'working' && tool) {
      if (tool.category === 'delegate') this.say(s, 'delegating', now);
      else this.status(s, toolText(tool.category, tool.name, tool.summary), now);
    }
    s.lastToolKey = toolKey;
    if (agent.status !== s.lastStatus) {
      if (agent.status === 'waiting') {
        this.status(s, 'waiting for you', now, BUBBLE_PRIORITY.urgent);
        this.say(s, 'waiting', now);
      } else if (agent.status === 'error') {
        this.say(s, 'error', now, BUBBLE_PRIORITY.urgent);
      }
    }
    s.lastStatus = agent.status;
  }

  private status(s: Sprite, text: string, now: number, priority?: number): void {
    if (!this.settings.statusBubbles) return;
    this.bubbles.push({ crewId: s.id, kind: 'status', text, priority }, now);
  }

  private say(s: Sprite, moment: PhraseMoment, now: number, priority?: number): void {
    if (!this.settings.catchphraseBubbles) return;
    const list = this.phrases(moment);
    if (list.length === 0) return;
    const text = list[Math.min(list.length - 1, Math.floor(this.random() * list.length))]!;
    this.bubbles.push({ crewId: s.id, kind: 'catchphrase', text, priority }, now);
  }

  // ------------------------------------------------------------------ views

  private view(s: Sprite): CrewView {
    const agent = s.agentKey ? this.snap?.agents[s.agentKey] : undefined;
    const orch =
      s.isOrchestrator && s.sessionId
        ? this.snap?.agents[agentKey(s.sessionId, ORCHESTRATOR_ID)]
        : undefined;
    const real = agent ?? orch;
    const status: AgentStatus = real?.status ?? 'idle';
    const tool = real?.currentTool;
    const v: CrewView = {
      id: s.id,
      isOrchestrator: s.isOrchestrator,
      label: s.label,
      variant: s.variant,
      x: s.x,
      y: s.y,
      facing: s.facing,
      anim: this.animFor(s, status, tool?.category),
      phase: s.phase,
      status,
      stepStartedAt: real?.stepStartedAt ?? s.phaseStartedAt,
      highlight: status === 'waiting',
      alpha: s.alpha,
    };
    if (s.agentKey) v.agentKey = s.agentKey;
    else if (s.isOrchestrator && s.sessionId) v.agentKey = agentKey(s.sessionId, ORCHESTRATOR_ID);
    const projectId = s.projectId ?? real?.projectId;
    if (projectId) v.projectId = projectId;
    if (tool) {
      v.tool = { name: tool.name, category: tool.category };
      if (tool.summary !== undefined) v.tool.summary = tool.summary;
    }
    if (this.selected && v.agentKey === this.selected) v.path = s.path.map((p) => ({ ...p }));
    return v;
  }

  private animFor(s: Sprite, status: AgentStatus, category?: ToolCategory): CrewAnim {
    if (s.path.length > 0) return 'walk';
    if (s.isOrchestrator) {
      switch (status) {
        case 'waiting':
          return 'wait';
        case 'thinking':
          return 'think';
        case 'working':
          return 'type';
        case 'error':
          return 'error';
        default:
          return 'sit';
      }
    }
    switch (s.phase) {
      case 'lounge_idle':
        return s.poolIndex % 2 === 0 ? 'sit' : 'idle';
      case 'reporting':
        return s.intent === 'report_error'
          ? 'error'
          : s.intent === 'report_waiting'
            ? 'wait'
            : 'report';
      case 'working':
        switch (status) {
          case 'working':
            return CATEGORY_ANIM[category ?? 'other'];
          case 'thinking':
            return 'think';
          case 'waiting':
            return 'wait';
          case 'done':
            return 'celebrate';
          case 'error':
            return 'error';
          case 'idle':
            return 'sit';
          default:
            return 'idle';
        }
      default:
        return 'idle';
    }
  }

  private zoneViews(now: number): Record<string, ZoneStatusView> {
    const out: Record<string, ZoneStatusView> = {};
    const snap = this.snap;
    if (!snap) return out;
    for (const p of Object.values(snap.projects)) {
      out[p.id] = {
        working: 0,
        waiting: 0,
        done: 0,
        flashing: false,
        dimmed: now - p.lastEventAt > this.settings.idleProjectMs,
      };
    }
    for (const a of Object.values(snap.agents)) {
      const z = out[a.projectId];
      if (!z) continue;
      if (a.status === 'working' || a.status === 'thinking') z.working++;
      else if (a.status === 'waiting') {
        z.waiting++;
        z.flashing = true;
      } else if (a.status === 'done') z.done++;
    }
    return out;
  }
}

/** Sanitized status text: category verb + the already-redacted tool summary. */
export function toolText(category: ToolCategory, name: string, summary?: string): string {
  const verb = CATEGORY_VERB[category];
  if (category === 'mcp') {
    const server = summary?.split(':')[0]?.trim() || name.split('__')[1] || 'a tool';
    return `using ${server}`;
  }
  if (summary) return `${verb} ${summary}`;
  return category === 'other' ? 'working' : verb;
}
