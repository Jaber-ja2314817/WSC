// "Needs your input" notifications. Plain TypeScript (no Electron import) so it is unit-testable.
import type { StationSnapshot } from '@shared/types';

const MAX_HELD = 16;

/**
 * Bodies of the notifications to show for agents that just started waiting. An agent is announced
 * once per wait: `notified` remembers it until it stops waiting. Only the agent label and project
 * name, never tool input.
 */
export function waitingAlerts(
  snap: StationSnapshot,
  notified: Set<string>,
  enabled: boolean,
): string[] {
  const bodies: string[] = [];
  const waiting = new Set<string>();
  for (const [key, a] of Object.entries(snap.agents)) {
    if (a.status !== 'waiting') continue;
    waiting.add(key);
    if (notified.has(key)) continue;
    notified.add(key);
    if (!enabled) continue;
    const project = snap.projects[a.projectId]?.name ?? 'a project';
    const who = a.isOrchestrator ? 'The orchestrator' : a.label;
    bodies.push(`${who} in ${project} needs your input`);
  }
  for (const key of [...notified]) if (!waiting.has(key)) notified.delete(key);
  return bodies;
}

interface Dismissible {
  once(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
}

/**
 * Keeps a notification referenced until it goes away: a garbage-collected one loses its click
 * handler. Some platforms never report a close, so only the newest few are held.
 */
export function holdUntilDismissed<T extends Dismissible>(held: Set<T>, notification: T): void {
  held.add(notification);
  const release = (): void => void held.delete(notification);
  notification.once('click', release);
  notification.once('close', release);
  notification.once('failed', release);
  if (held.size > MAX_HELD) {
    const oldest = held.values().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
}
