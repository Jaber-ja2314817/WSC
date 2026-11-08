// Talking to the renderer before it can listen, and deciding what a requested theme id means.
// Plain TypeScript (no Electron import) so it is unit-testable.

/** Commands that wait until the renderer has registered its listener: ipcRenderer doesn't buffer. */
export class CommandGate<Target, Command> {
  private ready: Target | null = null;
  private queue: Command[] = [];

  constructor(
    private readonly deliver: (target: Target, cmd: Command) => void,
    private readonly maxQueued = 32,
  ) {}

  /** `target` is the current window; null when there is none. */
  send(target: Target | null, cmd: Command): void {
    if (target !== null && target === this.ready) {
      this.deliver(target, cmd);
      return;
    }
    this.queue.push(cmd);
    if (this.queue.length > this.maxQueued) this.queue.shift();
  }

  /** The renderer in `target` is listening: everything held back goes to it, in order. */
  markReady(target: Target): void {
    this.ready = target;
    const queued = this.queue;
    this.queue = [];
    for (const cmd of queued) this.deliver(target, cmd);
  }

  /** `target` started loading a new page, so its listener is gone. */
  markLoading(target: Target): void {
    if (this.ready === target) this.ready = null;
  }
}

export type ThemeDecision = 'known' | 'unknown' | 'invalid' | 'defer';

/** Main only learns the built-in theme ids from the renderer: until then it can't judge an id. */
export function decideTheme(
  id: string,
  knownIds: readonly string[],
  themesReported: boolean,
  idPattern: RegExp,
): ThemeDecision {
  if (!idPattern.test(id)) return 'invalid';
  if (!themesReported) return 'defer';
  return knownIds.includes(id) ? 'known' : 'unknown';
}
