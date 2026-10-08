// Synthetic StationEvent builder for tests. No real paths, ids or output.
import { ORCHESTRATOR_ID, type StationEvent, type ToolCategory } from '../../src/shared/types';

let seq = 0;

export function resetSeq(): void {
  seq = 0;
}

export function ev(partial: Partial<StationEvent> & Pick<StationEvent, 'kind'>): StationEvent {
  seq++;
  return {
    id: `ev-${seq}`,
    ts: 1_000 + seq,
    source: 'demo',
    projectId: 'proj-a',
    projectName: 'project-a',
    sessionId: 'sess-1',
    agentId: ORCHESTRATOR_ID,
    ...partial,
  };
}

export function tool(
  name: string,
  category: ToolCategory,
  extra: { summary?: string; ok?: boolean; useId?: string } = {},
): NonNullable<StationEvent['tool']> {
  return { name, category, ...extra };
}
