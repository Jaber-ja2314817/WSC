import { beforeEach, describe, expect, it } from 'vitest';
import { Director } from '../src/renderer/director/director';
import type {
  CrewView,
  DirectorFrame,
  FindPath,
  PhraseMoment,
} from '../src/renderer/director/types';
import type { StationLayout, TilePos } from '../src/shared/layoutTypes';
import { StationStore } from '../src/shared/store';
import type { StationEvent, StationSnapshot } from '../src/shared/types';
import { ev, resetSeq, tool } from './fixtures/events';

// --- fixtures -------------------------------------------------------------

const W = 30;
const H = 20;

function layout(): StationLayout {
  return {
    width: W,
    height: H,
    floor: Array<'center'>(W * H).fill('center'),
    walkable: Array<boolean>(W * H).fill(true),
    center: {
      rect: { x: 10, y: 5, w: 10, h: 10 },
      table: { x: 13, y: 7, w: 4, h: 2 },
      tableSeats: [
        { id: 'seat-0', tile: { x: 12, y: 8 }, facing: 'right' },
        { id: 'seat-1', tile: { x: 17, y: 8 }, facing: 'left' },
      ],
      reportSpots: [
        { id: 'rep-0', tile: { x: 14, y: 10 }, facing: 'up' },
        { id: 'rep-1', tile: { x: 15, y: 10 }, facing: 'up' },
        { id: 'rep-2', tile: { x: 16, y: 10 }, facing: 'up' },
      ],
      lounge: { x: 10, y: 12, w: 10, h: 3 },
      loungeSpots: [
        { id: 'l-0', tile: { x: 11, y: 13 }, facing: 'down' },
        { id: 'l-1', tile: { x: 12, y: 13 }, facing: 'down' },
        { id: 'l-2', tile: { x: 13, y: 13 }, facing: 'down' },
      ],
      arrival: { x: 15, y: 14 },
      decor: [],
    },
    zones: [
      {
        projectId: 'proj-a',
        name: 'project-a',
        slot: 0,
        rect: { x: 0, y: 0, w: 8, h: 8 },
        nameplate: { x: 1, y: 0 },
        door: { x: 4, y: 7 },
        desks: [
          {
            id: 'a-d0',
            desk: { x: 1, y: 1 },
            seat: { id: 'a-s0', tile: { x: 1, y: 2 }, facing: 'up' },
          },
          {
            id: 'a-d1',
            desk: { x: 4, y: 1 },
            seat: { id: 'a-s1', tile: { x: 4, y: 2 }, facing: 'up' },
          },
        ],
        decor: [],
      },
      {
        projectId: 'proj-b',
        name: 'project-b',
        slot: 1,
        rect: { x: 22, y: 0, w: 8, h: 8 },
        nameplate: { x: 23, y: 0 },
        door: { x: 25, y: 7 },
        desks: [
          {
            id: 'b-d0',
            desk: { x: 23, y: 1 },
            seat: { id: 'b-s0', tile: { x: 23, y: 2 }, facing: 'up' },
          },
          {
            id: 'b-d1',
            desk: { x: 26, y: 1 },
            seat: { id: 'b-s1', tile: { x: 26, y: 2 }, facing: 'up' },
          },
        ],
        decor: [],
      },
    ],
  };
}

/** Straight-line Manhattan path (x first, then y), excluding the start tile. */
const straight: FindPath = (from, to) => {
  const out: TilePos[] = [];
  let { x, y } = from;
  while (x !== to.x) {
    x += Math.sign(to.x - x);
    out.push({ x, y });
  }
  while (y !== to.y) {
    y += Math.sign(to.y - y);
    out.push({ x, y });
  }
  return out;
};

const PHRASES: Record<PhraseMoment, string[]> = {
  assigned: ['On it!'],
  heading_out: ['Back to it.'],
  done: ['All done, captain!'],
  error: ['Hmm… that broke.'],
  waiting: ['Need your call on this one.'],
  lounge: ['Coffee break.'],
  delegating: ['You — take this one.'],
  arrive: ['Reporting for duty.'],
};

// --- harness --------------------------------------------------------------

let store: StationStore;
let director: Director;
let now: number;
let frame: DirectorFrame;

function make(
  settings: ConstructorParameters<typeof Director>[0]['settings'] = {},
  findPath = straight,
): void {
  store = new StationStore();
  director = new Director({
    findPath,
    phrases: (m) => PHRASES[m],
    settings: { loungeSize: 3, ...settings },
    random: () => 0,
  });
  director.setLayout(layout());
  now = 10_000;
  frame = director.update(now, 0);
}

function push(...events: StationEvent[]): void {
  store.applyMany(events);
  director.setSnapshot(store.snapshot(), now);
}

function run(ms: number, step = 50): DirectorFrame {
  for (let t = 0; t < ms; t += step) {
    now += step;
    frame = director.update(now, step);
  }
  return frame;
}

const crew = (id: string): CrewView => {
  const c = frame.crew.find((x) => x.id === id);
  if (!c) throw new Error(`no crew ${id}`);
  return c;
};
const byAgent = (key: string): CrewView | undefined => frame.crew.find((x) => x.agentKey === key);
const at = (c: CrewView): string => `${c.x},${c.y}`;

const spawn = (agentId: string, extra: Partial<StationEvent> = {}): StationEvent =>
  ev({ kind: 'agent_spawn', agentId, label: 'researcher', ...extra });

beforeEach(() => resetSeq());

// --- tests ----------------------------------------------------------------

describe('Director — lounge pool', () => {
  it('starts with loungeSize free crew in the lounge', () => {
    make();
    const free = frame.crew.filter((c) => !c.isOrchestrator);
    expect(free.map((c) => c.id)).toEqual(['crew-0', 'crew-1', 'crew-2']);
    expect(free.every((c) => c.phase === 'lounge_idle' && c.status === 'idle')).toBe(true);
    expect(at(crew('crew-0'))).toBe('11,13');
    expect(crew('crew-1').variant).not.toBe(crew('crew-0').variant);
  });

  it('returns no crew before a layout exists', () => {
    const d = new Director({ findPath: straight, phrases: () => [] });
    expect(d.update(0, 16).crew).toEqual([]);
  });

  it('grows and shrinks the pool with settings', () => {
    make();
    director.setSettings({ loungeSize: 5 });
    run(50);
    expect(frame.crew.filter((c) => !c.isOrchestrator)).toHaveLength(5);
    director.setSettings({ loungeSize: 2 });
    run(50);
    expect(frame.crew.filter((c) => !c.isOrchestrator)).toHaveLength(2);
  });
});

describe('Director — assignment and walking', () => {
  it('binds the lowest free crew, pauses, then walks to a desk in the right zone', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(50);
    const c = crew('crew-0');
    expect(c.agentKey).toBe('sess-1:a1');
    expect(c.label).toBe('researcher');
    expect(c.phase).toBe('assigned');
    expect(frame.bubbles.some((b) => b.crewId === 'crew-0' && b.text === 'On it!')).toBe(true);
    run(700);
    expect(crew('crew-0').phase).toBe('walking_to_zone');
    expect(crew('crew-0').anim).toBe('walk');
    run(5000);
    const arrived = crew('crew-0');
    expect(arrived.phase).toBe('working');
    expect(at(arrived)).toBe('1,2');
    expect(arrived.facing).toBe('up');
  });

  it('puts agents of two projects in their own zones', () => {
    make();
    push(
      ev({ kind: 'session_start' }),
      ev({
        kind: 'session_start',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
      }),
      spawn('a1'),
      spawn('b1', { sessionId: 'sess-2', projectId: 'proj-b', projectName: 'project-b' }),
    );
    run(6000);
    expect(at(byAgent('sess-1:a1')!)).toBe('1,2');
    expect(at(byAgent('sess-2:b1')!)).toBe('23,2');
    expect(byAgent('sess-2:b1')!.projectId).toBe('proj-b');
  });

  it('gives two agents in one zone different desks', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'), spawn('a2'));
    run(6000);
    expect(at(byAgent('sess-1:a1')!)).toBe('1,2');
    expect(at(byAgent('sess-1:a2')!)).toBe('4,2');
  });

  it('caps long walks at about 4 seconds', () => {
    make({ walkSpeed: 1 });
    push(
      ev({
        kind: 'session_start',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
      }),
      spawn('b1', { sessionId: 'sess-2', projectId: 'proj-b', projectName: 'project-b' }),
    );
    run(650); // assign pause
    run(4100);
    expect(byAgent('sess-2:b1')!.phase).toBe('working');
  });

  it('snaps when no path is found', () => {
    make({}, () => null);
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(700);
    const c = byAgent('sess-1:a1')!;
    expect(at(c)).toBe('1,2');
    expect(c.phase).toBe('working');
  });

  it('reduceMotion snaps straight to destinations', () => {
    make({ reduceMotion: true });
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(700);
    const c = byAgent('sess-1:a1')!;
    expect(at(c)).toBe('1,2');
    expect(c.anim).not.toBe('walk');
  });

  it('brings in an extra crew member when the pool is exhausted', () => {
    make({ loungeSize: 1 });
    push(ev({ kind: 'session_start' }), spawn('a1'), spawn('a2'));
    run(50);
    const extra = byAgent('sess-1:a2')!;
    expect(extra.id).toBe('crew-1');
    expect(extra.phase).toBe('arriving');
    expect(at(extra)).toBe('15,14');
    expect(extra.alpha).toBeLessThan(1);
    run(6000);
    expect(byAgent('sess-1:a2')!.phase).toBe('working');
    expect(byAgent('sess-1:a2')!.alpha).toBe(1);
  });
});

describe('Director — animations follow the real tool', () => {
  it.each([
    ['Read', 'read', 'read'],
    ['Grep', 'search', 'scan'],
    ['Edit', 'write', 'type'],
    ['Bash', 'execute', 'terminal'],
    ['WebSearch', 'web', 'comms'],
    ['TodoWrite', 'plan', 'scan'],
    ['mcp__x__y', 'mcp', 'terminal'],
    ['Weird', 'other', 'type'],
  ] as const)('%s (%s) → %s', (name, category, anim) => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'tool_start', agentId: 'a1', tool: tool(name, category, { useId: 'u1' }) }));
    run(50);
    expect(byAgent('sess-1:a1')!.anim).toBe(anim);
  });

  it('thinking between tools → think', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    expect(byAgent('sess-1:a1')!.anim).toBe('think');
  });
});

describe('Director — reporting', () => {
  it('done → walks to the center, reports, returns to the lounge and is free again', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'agent_finish', agentId: 'a1' }));
    run(50);
    expect(crew('crew-0').phase).toBe('walking_to_center');
    expect(crew('crew-0').status).toBe('done');
    run(5000);
    // reported, then left
    run(2500);
    run(5000);
    const c = crew('crew-0');
    expect(c.phase).toBe('lounge_idle');
    expect(c.agentKey).toBeUndefined();
    expect(c.label).toBe('crew 1');
    expect(at(c)).toBe('11,13');
    // free again: the next spawn reuses it
    push(spawn('a2'));
    run(50);
    expect(crew('crew-0').agentKey).toBe('sess-1:a2');
  });

  it('reaches the report spot and plays the report animation', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'agent_finish', agentId: 'a1' }));
    run(50);
    expect(frame.bubbles.some((b) => b.text === 'All done, captain!')).toBe(true);
    run(4500);
    const c = crew('crew-0');
    expect(c.phase).toBe('reporting');
    expect(c.anim).toBe('report');
    expect(['14,10', '15,10', '16,10']).toContain(at(c));
  });

  it('error → reports with the error animation, then lounge', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'agent_error', agentId: 'a1' }));
    run(50);
    expect(frame.bubbles.some((b) => b.text === 'Hmm… that broke.')).toBe(true);
    run(4500);
    expect(crew('crew-0').anim).toBe('error');
    run(8000);
    expect(crew('crew-0').phase).toBe('lounge_idle');
  });

  it('waiting → reports, stays highlighted until resolved, then returns to its desk', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'waiting_for_user', agentId: 'a1' }));
    run(10_000);
    let c = byAgent('sess-1:a1')!;
    expect(c.phase).toBe('reporting');
    expect(c.highlight).toBe(true);
    expect(c.anim).toBe('wait');
    expect(frame.bubbles.some((b) => b.text === 'waiting for you')).toBe(false); // expired by now
    push(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: 'u9' }) }));
    run(50);
    c = byAgent('sess-1:a1')!;
    expect(c.highlight).toBe(false);
    expect(c.phase).toBe('walking_to_zone');
    run(5000);
    expect(at(byAgent('sess-1:a1')!)).toBe('1,2');
  });

  it('minimal: done goes straight back to the lounge', () => {
    make({ reportFrequency: 'minimal' });
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'agent_finish', agentId: 'a1' }));
    run(50);
    expect(crew('crew-0').phase).toBe('walking_to_lounge');
  });

  it('chatty: checks in after every 5 tool calls, then goes back to work', () => {
    make({ reportFrequency: 'chatty' });
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    for (let i = 0; i < 5; i++) {
      push(
        ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: `t${i}` }) }),
      );
      push(ev({ kind: 'tool_end', agentId: 'a1', tool: tool('Read', 'read', { useId: `t${i}` }) }));
    }
    run(50);
    expect(byAgent('sess-1:a1')!.phase).toBe('walking_to_center');
    run(4500);
    expect(byAgent('sess-1:a1')!.phase).toBe('reporting');
    run(1600);
    run(5000);
    expect(byAgent('sess-1:a1')!.phase).toBe('working');
  });

  it('normal: no check-ins after tool calls', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    for (let i = 0; i < 6; i++) {
      push(
        ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: `t${i}` }) }),
      );
    }
    run(50);
    expect(byAgent('sess-1:a1')!.phase).toBe('working');
  });

  it('an agent vanishing from the snapshot sends its crew back to the lounge', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    const snap: StationSnapshot = store.snapshot();
    delete snap.agents['sess-1:a1'];
    director.setSnapshot(snap, now);
    run(50);
    const c = crew('crew-0');
    expect(c.agentKey).toBeUndefined();
    expect(c.phase).toBe('walking_to_lounge');
    run(5000);
    expect(crew('crew-0').phase).toBe('lounge_idle');
  });

  it('agents finished before they were ever seen are not choreographed', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'), ev({ kind: 'agent_finish', agentId: 'a1' }));
    run(50);
    expect(byAgent('sess-1:a1')).toBeUndefined();
  });
});

describe('Director — truth beats animation', () => {
  it('mirrors status and tool immediately while walking', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(800);
    expect(crew('crew-0').phase).toBe('walking_to_zone');
    push(
      ev({
        kind: 'tool_start',
        agentId: 'a1',
        tool: tool('Read', 'read', { summary: 'auth.ts', useId: 'u1' }),
      }),
    );
    run(50);
    const c = crew('crew-0');
    expect(c.phase).toBe('walking_to_zone');
    expect(c.status).toBe('working');
    expect(c.tool).toEqual({ name: 'Read', category: 'read', summary: 'auth.ts' });
    expect(c.stepStartedAt).toBe(store.snapshot().agents['sess-1:a1']!.stepStartedAt);
  });

  it('retargets mid-walk when the status changes', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(800);
    push(ev({ kind: 'agent_error', agentId: 'a1' }));
    run(50);
    expect(crew('crew-0').phase).toBe('walking_to_center');
    expect(crew('crew-0').status).toBe('error');
  });

  it('snaps instead of walking when state churns', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'waiting_for_user', agentId: 'a1' }));
    run(50);
    push(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: 'x1' }) }));
    run(50);
    push(ev({ kind: 'waiting_for_user', agentId: 'a1' }));
    run(50);
    push(ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: 'x2' }) }));
    run(50);
    const c = byAgent('sess-1:a1')!;
    expect(at(c)).toBe('1,2');
    expect(c.phase).toBe('working');
  });
});

describe('Director — orchestrators', () => {
  it('seats one orchestrator per session, labeled with the project name', () => {
    make();
    push(
      ev({ kind: 'session_start' }),
      ev({
        kind: 'session_start',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
      }),
    );
    run(50);
    const o1 = crew('orch:sess-1');
    const o2 = crew('orch:sess-2');
    expect(o1.isOrchestrator).toBe(true);
    expect(at(o1)).toBe('12,8');
    expect(at(o2)).toBe('17,8');
    expect(o1.label).toBe('project-a');
    expect(o2.label).toBe('project-b');
    expect(o1.phase).toBe('seated');
    expect(o1.agentKey).toBe('sess-1:orchestrator');
  });

  it('animates by status and says a delegating line', () => {
    make();
    push(ev({ kind: 'session_start' }), ev({ kind: 'user_prompt' }));
    run(50);
    expect(crew('orch:sess-1').anim).toBe('think');
    push(
      ev({
        kind: 'tool_start',
        tool: tool('Agent', 'delegate', { useId: 'd1', summary: 'researcher' }),
      }),
    );
    run(50);
    expect(crew('orch:sess-1').anim).toBe('type');
    expect(
      frame.bubbles.some((b) => b.crewId === 'orch:sess-1' && b.text === 'You — take this one.'),
    ).toBe(true);
    push(ev({ kind: 'waiting_for_user' }));
    run(50);
    expect(crew('orch:sess-1').highlight).toBe(true);
    expect(crew('orch:sess-1').anim).toBe('wait');
  });

  it('removed session: its orchestrator fades out and frees the seat', () => {
    make();
    push(ev({ kind: 'session_start' }));
    run(50);
    const snap = store.snapshot();
    delete snap.sessions['sess-1'];
    delete snap.agents['sess-1:orchestrator'];
    director.setSnapshot(snap, now);
    run(1000);
    expect(frame.crew.find((c) => c.id === 'orch:sess-1')).toBeUndefined();
    const other = new StationStore();
    other.apply(ev({ kind: 'session_start', sessionId: 'sess-3' }));
    director.setSnapshot(other.snapshot(), now);
    run(50);
    expect(at(crew('orch:sess-3'))).toBe('12,8');
  });
});

describe('Director — bubbles', () => {
  it('status bubbles describe the sanitized tool', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(
      ev({
        kind: 'tool_start',
        agentId: 'a1',
        tool: tool('Read', 'read', { summary: 'auth.ts', useId: 'u1' }),
      }),
    );
    run(50);
    expect(frame.bubbles.some((b) => b.kind === 'status' && b.text === 'reading auth.ts')).toBe(
      true,
    );
  });

  it('respects the status and catchphrase toggles', () => {
    make({ statusBubbles: false, catchphraseBubbles: false });
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(
      ev({
        kind: 'tool_start',
        agentId: 'a1',
        tool: tool('Read', 'read', { summary: 'a.ts', useId: 'u1' }),
      }),
    );
    push(ev({ kind: 'agent_finish', agentId: 'a1' }));
    run(50);
    expect(frame.bubbles).toEqual([]);
  });

  it('only catchphrases when status bubbles are off', () => {
    make({ statusBubbles: false });
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(50);
    expect(frame.bubbles.map((b) => b.kind)).toEqual(['catchphrase']);
  });

  it('never stacks two bubbles of a crew on the same row', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'));
    run(6000);
    push(ev({ kind: 'waiting_for_user', agentId: 'a1' }));
    run(50);
    const mine = frame.bubbles.filter((b) => b.crewId === 'crew-0');
    expect(new Set(mine.map((b) => b.stack)).size).toBe(mine.length);
  });

  it('skips moments with no phrases', () => {
    store = new StationStore();
    director = new Director({ findPath: straight, phrases: () => [], settings: { loungeSize: 1 } });
    director.setLayout(layout());
    now = 10_000;
    push(ev({ kind: 'session_start' }), spawn('a1'));
    frame = director.update(now + 50, 50);
    expect(frame.bubbles.filter((b) => b.kind === 'catchphrase')).toEqual([]);
  });
});

describe('Director — zones', () => {
  it('counts working, waiting and done per project; flashes on waiting; dims when idle', () => {
    make();
    push(
      ev({ kind: 'session_start' }),
      spawn('a1'),
      spawn('a2'),
      ev({ kind: 'tool_start', agentId: 'a1', tool: tool('Read', 'read', { useId: 'u1' }) }),
      ev({ kind: 'waiting_for_user', agentId: 'a2' }),
      ev({
        kind: 'session_start',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
      }),
      spawn('b1', { sessionId: 'sess-2', projectId: 'proj-b', projectName: 'project-b' }),
      ev({
        kind: 'agent_finish',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
        agentId: 'b1',
      }),
    );
    run(50);
    expect(frame.zones['proj-a']).toMatchObject({
      working: 1,
      waiting: 1,
      flashing: true,
      dimmed: false,
    });
    expect(frame.zones['proj-b']).toMatchObject({ done: 1, waiting: 0, flashing: false });
    now += 31 * 60_000;
    frame = director.update(now, 16);
    expect(frame.zones['proj-a']!.dimmed).toBe(true);
  });
});

describe('Director — selection', () => {
  it('fills the remaining path only for the selected agent', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'), spawn('a2'));
    director.select('sess-1:a1');
    run(800);
    expect(byAgent('sess-1:a1')!.path!.length).toBeGreaterThan(0);
    expect(byAgent('sess-1:a2')!.path).toBeUndefined();
  });
});

describe('Director — determinism', () => {
  it('produces identical frames for identical inputs', () => {
    const go = (): string => {
      resetSeq();
      make();
      push(ev({ kind: 'session_start' }), spawn('a1'), spawn('a2'));
      run(3000);
      push(ev({ kind: 'agent_finish', agentId: 'a1' }));
      return JSON.stringify(run(3000));
    };
    expect(go()).toEqual(go());
  });
});

describe('Director — layout changes', () => {
  const shifted = (dx: number, dy: number): StationLayout => {
    const l = layout();
    const mv = (p: TilePos): TilePos => ({ x: p.x + dx, y: p.y + dy });
    l.center.rect = { ...l.center.rect, x: l.center.rect.x + dx, y: l.center.rect.y + dy };
    l.center.tableSeats = l.center.tableSeats.map((s) => ({ ...s, tile: mv(s.tile) }));
    l.center.reportSpots = l.center.reportSpots.map((s) => ({ ...s, tile: mv(s.tile) }));
    l.center.loungeSpots = l.center.loungeSpots.map((s) => ({ ...s, tile: mv(s.tile) }));
    l.center.arrival = mv(l.center.arrival);
    for (const z of l.zones) {
      z.door = mv(z.door);
      z.desks = z.desks.map((d) => ({
        ...d,
        desk: mv(d.desk),
        seat: { ...d.seat, tile: mv(d.seat.tile) },
      }));
    }
    return l;
  };

  it('offsets resting and walking crew by the center delta and exposes the shift', () => {
    make();
    push(ev({ kind: 'session_start' }), spawn('a1'), spawn('a2'));
    run(6000);
    push(spawn('a3'));
    run(900); // a3 is mid-walk
    const walker = byAgent('sess-1:a3')!;
    expect(walker.phase).toBe('walking_to_zone');
    const before = { x: walker.x, y: walker.y };
    director.setLayout(shifted(5, 3));
    expect(director.lastLayoutShift).toEqual({ dx: 5, dy: 3 });
    frame = director.update(now, 0);
    expect(at(byAgent('sess-1:a1')!)).toBe('6,5');
    expect(at(crew('orch:sess-1'))).toBe('17,11');
    // Replanning starts from the nearest whole tile: at most half a tile of drift.
    expect(Math.abs(byAgent('sess-1:a3')!.x - (before.x + 5))).toBeLessThanOrEqual(0.5);
    expect(Math.abs(byAgent('sess-1:a3')!.y - (before.y + 3))).toBeLessThanOrEqual(0.5);
    run(6000);
    // a3 had no desk left in zone a (2 desks) → it waits at the shifted zone door
    expect(at(byAgent('sess-1:a3')!)).toBe('9,10');
    expect(at(crew('crew-2'))).not.toBe('13,13');
  });

  it('works end to end with the real layout and A*', async () => {
    const { computeLayout } = await import('../src/shared/layout');
    const { makePathfinder } = await import('../src/shared/astar');
    store = new StationStore();
    const l = computeLayout({
      projects: [
        { id: 'proj-a', name: 'project-a', order: 0, agentCount: 2 },
        { id: 'proj-b', name: 'project-b', order: 1, agentCount: 1 },
      ],
      orchestratorSeats: 2,
      loungeSize: 6,
    });
    director = new Director({
      findPath: makePathfinder(l),
      phrases: (m) => PHRASES[m],
      random: () => 0,
    });
    director.setLayout(l);
    now = 10_000;
    push(
      ev({ kind: 'session_start' }),
      ev({
        kind: 'session_start',
        sessionId: 'sess-2',
        projectId: 'proj-b',
        projectName: 'project-b',
      }),
      spawn('a1'),
      spawn('a2'),
      spawn('b1', { sessionId: 'sess-2', projectId: 'proj-b', projectName: 'project-b' }),
    );
    run(8000);
    const seats = new Map(
      l.zones.flatMap((z) =>
        z.desks.map((d) => [`${d.seat.tile.x},${d.seat.tile.y}`, z.projectId]),
      ),
    );
    for (const key of ['sess-1:a1', 'sess-1:a2', 'sess-2:b1']) {
      const c = byAgent(key)!;
      expect(c.phase).toBe('working');
      expect(seats.get(at(c))).toBe(c.projectId);
    }
    // a third project appears: layout grows; everyone stays at their (shifted) desks
    const l2 = computeLayout({
      projects: [
        { id: 'proj-a', name: 'project-a', order: 0, agentCount: 2 },
        { id: 'proj-b', name: 'project-b', order: 1, agentCount: 1 },
        { id: 'proj-c', name: 'project-c', order: 2, agentCount: 0 },
      ],
      orchestratorSeats: 2,
      loungeSize: 6,
    });
    director.setLayout(l2, makePathfinder(l2));
    frame = director.update(now, 0);
    const seats2 = new Map(
      l2.zones.flatMap((z) =>
        z.desks.map((d) => [`${d.seat.tile.x},${d.seat.tile.y}`, z.projectId]),
      ),
    );
    for (const key of ['sess-1:a1', 'sess-1:a2', 'sess-2:b1']) {
      const c = byAgent(key)!;
      expect(seats2.get(at(c))).toBe(c.projectId);
    }
  });
});
