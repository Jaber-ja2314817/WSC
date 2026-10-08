// Pure view-model helpers for the side panels (no DOM, no Preact).
import type { AgentState, AgentStatus, StationSnapshot } from '@shared/types';

export const STATUS_TEXT: Record<AgentStatus, string> = {
  idle: 'idle',
  thinking: 'thinking',
  working: 'working',
  waiting: 'needs you',
  done: 'done',
  error: 'error',
  stale: 'no signal',
};

export interface ProjectRow {
  id: string;
  name: string;
  working: number;
  waiting: number;
  done: number;
  agents: number;
}

export interface AgentRow {
  key: string;
  agent: AgentState;
  name: string;
  projectName: string;
}

const isBusy = (s: AgentStatus): boolean => s === 'working' || s === 'thinking';

export function projectRows(snap: StationSnapshot): ProjectRow[] {
  return Object.values(snap.projects)
    .sort((a, b) => a.order - b.order)
    .map((p) => {
      const agents = Object.values(snap.agents).filter((a) => a.projectId === p.id);
      return {
        id: p.id,
        name: p.name,
        working: agents.filter((a) => isBusy(a.status)).length,
        waiting: agents.filter((a) => a.status === 'waiting').length,
        done: agents.filter((a) => a.status === 'done').length,
        agents: agents.length,
      };
    });
}

/** Display name: subagent label, or "orchestrator" (+ short session id when a project has several). */
export function agentName(snap: StationSnapshot, a: AgentState): string {
  if (!a.isOrchestrator) return a.label || 'agent';
  const sessions = snap.projects[a.projectId]?.sessionIds.length ?? 1;
  return sessions > 1 ? `orchestrator · ${a.sessionId.slice(0, 6)}` : 'orchestrator';
}

export function agentRows(snap: StationSnapshot): AgentRow[] {
  const order = (projectId: string): number => snap.projects[projectId]?.order ?? 1e9;
  return Object.entries(snap.agents)
    .map(([key, agent]) => ({
      key,
      agent,
      name: agentName(snap, agent),
      projectName: snap.projects[agent.projectId]?.name ?? '?',
    }))
    .sort(
      (x, y) =>
        order(x.agent.projectId) - order(y.agent.projectId) ||
        Number(y.agent.isOrchestrator) - Number(x.agent.isOrchestrator) ||
        x.agent.spawnedAt - y.agent.spawnedAt,
    );
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
