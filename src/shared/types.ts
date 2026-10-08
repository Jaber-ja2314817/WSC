// Internal event schema and state model. Pure types — no runtime imports.
// Raw Claude Code formats never appear here; see normalizer.ts.

export type ToolCategory =
  'read' | 'search' | 'write' | 'execute' | 'web' | 'delegate' | 'plan' | 'mcp' | 'other';

export type StationEventKind =
  | 'session_start'
  | 'session_end'
  | 'agent_spawn'
  | 'agent_finish'
  | 'agent_error'
  | 'tool_start'
  | 'tool_end'
  | 'waiting_for_user'
  | 'user_prompt'
  | 'idle'
  | 'compacting';

export type EventSource = 'hook' | 'transcript' | 'demo';

export const ORCHESTRATOR_ID = 'orchestrator';

export interface StationEvent {
  /** Unique, for dedupe (hook + transcript can report the same thing). */
  id: string;
  /** Epoch ms. */
  ts: number;
  source: EventSource;
  /** Hash of the working directory. */
  projectId: string;
  /** Folder basename of the working directory. */
  projectName: string;
  sessionId: string;
  /** ORCHESTRATOR_ID for the session's lead agent, else the subagent id. */
  agentId: string;
  parentAgentId?: string;
  kind: StationEventKind;
  tool?: {
    name: string;
    category: ToolCategory;
    /** Short, sanitized summary — never raw tool input. */
    summary?: string;
    ok?: boolean;
    /** Correlates tool_start/tool_end. */
    useId?: string;
  };
  /** Subagent type/description, e.g. "researcher". */
  label?: string;
}

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'error' | 'stale';

export interface AgentState {
  id: string;
  sessionId: string;
  projectId: string;
  isOrchestrator: boolean;
  parentAgentId?: string;
  label: string;
  status: AgentStatus;
  /** Current tool when status === 'working'. */
  currentTool?: { name: string; category: ToolCategory; summary?: string; useId?: string };
  /** When the current step (status/tool) began, epoch ms. */
  stepStartedAt: number;
  lastEventAt: number;
  spawnedAt: number;
  finishedAt?: number;
  toolCalls: number;
}

export interface SessionState {
  id: string;
  projectId: string;
  startedAt: number;
  lastEventAt: number;
  endedAt?: number;
  /** Agent ids belonging to this session (orchestrator first). */
  agentIds: string[];
}

export interface ProjectState {
  id: string;
  name: string;
  /** Stable order of creation; drives zone placement. */
  order: number;
  createdAt: number;
  lastEventAt: number;
  sessionIds: string[];
}

export interface LogEntry {
  id: string;
  ts: number;
  projectId: string;
  sessionId: string;
  agentId: string;
  kind: StationEventKind;
  text: string;
}

export interface StationSnapshot {
  projects: Record<string, ProjectState>;
  sessions: Record<string, SessionState>;
  /** Keyed by `${sessionId}:${agentId}` — see agentKey(). */
  agents: Record<string, AgentState>;
  log: LogEntry[];
  eventsReceived: number;
}

export const agentKey = (sessionId: string, agentId: string): string => `${sessionId}:${agentId}`;
