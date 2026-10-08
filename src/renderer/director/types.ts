// Director output contract: what the scene draws each frame. No Pixi or DOM imports here.
import type { Dir, TilePos } from '@shared/layoutTypes';
import type { AgentStatus, ToolCategory } from '@shared/types';

/** Animation a crew sprite plays. Themes must provide frames for every one of these. */
export type CrewAnim =
  | 'idle'
  | 'walk'
  | 'sit'
  | 'type'
  | 'read'
  | 'scan'
  | 'terminal'
  | 'comms'
  | 'report'
  | 'celebrate'
  | 'error'
  | 'wait'
  | 'think';

export const CREW_ANIMS: readonly CrewAnim[] = [
  'idle',
  'walk',
  'sit',
  'type',
  'read',
  'scan',
  'terminal',
  'comms',
  'report',
  'celebrate',
  'error',
  'wait',
  'think',
];

/** Choreography phase (brief §5.3). */
export type CrewPhase =
  | 'lounge_idle'
  | 'arriving'
  | 'assigned'
  | 'walking_to_zone'
  | 'working'
  | 'walking_to_center'
  | 'reporting'
  | 'walking_to_lounge'
  | 'seated';

/** Catchphrase moments; theme.json `phrases` has a list per moment. */
export type PhraseMoment =
  'assigned' | 'heading_out' | 'done' | 'error' | 'waiting' | 'lounge' | 'delegating' | 'arrive';

export const PHRASE_MOMENTS: readonly PhraseMoment[] = [
  'assigned',
  'heading_out',
  'done',
  'error',
  'waiting',
  'lounge',
  'delegating',
  'arrive',
];

export interface CrewView {
  /** Stable sprite id (lounge pool member or orchestrator seat). */
  id: string;
  /** `${sessionId}:${agentId}` when bound to a real agent. */
  agentKey?: string;
  isOrchestrator: boolean;
  label: string;
  /** Appearance variation index (hair/outfit/colors), stable per sprite. */
  variant: number;
  projectId?: string;
  /** Tile coordinates, fractional while walking. */
  x: number;
  y: number;
  facing: Dir;
  anim: CrewAnim;
  phase: CrewPhase;
  /** Real status of the bound agent, or 'idle' for free crew. Truth beats animation. */
  status: AgentStatus;
  tool?: { name: string; category: ToolCategory; summary?: string };
  /** For the elapsed-time label. */
  stepStartedAt: number;
  /** Waiting for user: draw attention highlight. */
  highlight: boolean;
  /** 0..1, for arrive/leave fades. */
  alpha: number;
  /** Path remaining (for drawing the selected agent's route). */
  path?: TilePos[];
}

export interface BubbleView {
  id: string;
  crewId: string;
  kind: 'status' | 'catchphrase';
  text: string;
  bornAt: number;
  ttlMs: number;
  /** Vertical stack offset (0 = closest to the head) so bubbles never overlap. */
  stack: number;
}

export interface ZoneStatusView {
  working: number;
  waiting: number;
  done: number;
  /** Nameplate flashes while anyone in the zone waits for the user. */
  flashing: boolean;
  /** No activity for idleProjectMs → dimmed. */
  dimmed: boolean;
}

export interface DirectorFrame {
  crew: CrewView[];
  bubbles: BubbleView[];
  zones: Record<string, ZoneStatusView>;
}

export type ReportFrequency = 'minimal' | 'normal' | 'chatty';

export interface DirectorSettings {
  loungeSize: number;
  reportFrequency: ReportFrequency;
  statusBubbles: boolean;
  catchphraseBubbles: boolean;
  /** Snap instead of walk. */
  reduceMotion: boolean;
  bubbleTtlMs: number;
  idleProjectMs: number;
  /** Tiles per second. */
  walkSpeed: number;
}

export const DEFAULT_DIRECTOR_SETTINGS: DirectorSettings = {
  loungeSize: 6,
  reportFrequency: 'normal',
  statusBubbles: true,
  catchphraseBubbles: true,
  reduceMotion: false,
  bubbleTtlMs: 2500,
  idleProjectMs: 30 * 60_000,
  walkSpeed: 4,
};

/** Pathfinder injected into the director (A* in production, straight lines in tests). */
export type FindPath = (from: TilePos, to: TilePos) => TilePos[] | null;
