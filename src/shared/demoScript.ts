// Scripted demo run (brief §6.8). Pure and deterministic for a given t0.
// Two projects from the start, a third that appears mid-run; one agent waits for permission,
// one errors; everyone finishes and the sessions end. All names and paths are synthetic.
import { projectIdFor, projectNameFor } from './projects';
import { categorizeTool } from './toolCategories';
import { ORCHESTRATOR_ID, type StationEvent, type StationEventKind } from './types';

export interface DemoStep {
  /** Offset from t0 in ms. */
  at: number;
  event: StationEvent;
}

/** Length of one demo loop; the player starts a fresh loop (new ids) after this. */
export const DEMO_DURATION_MS = 60_000;

interface Ctx {
  sessionId: string;
  cwd: string;
}

export function buildDemoScript(t0: number): DemoStep[] {
  const tag = `demo-${t0.toString(36)}`;
  const steps: DemoStep[] = [];
  let useSeq = 0;

  const emit = (
    at: number,
    ctx: Ctx,
    agentId: string,
    kind: StationEventKind,
    extra: Partial<StationEvent> = {},
    idSuffix = `${kind}:${at}`,
  ): void => {
    const s = Math.round(at * 1000);
    steps.push({
      at: s,
      event: {
        id: `${ctx.sessionId}:${agentId}:${idSuffix}`,
        ts: t0 + s,
        source: 'demo',
        projectId: projectIdFor(ctx.cwd),
        projectName: projectNameFor(ctx.cwd),
        sessionId: ctx.sessionId,
        agentId,
        ...(agentId !== ORCHESTRATOR_ID ? { parentAgentId: ORCHESTRATOR_ID } : {}),
        kind,
        ...extra,
      },
    });
  };

  /** A tool call from `start` to `end` seconds; ok=false marks a failed call. */
  const tool = (
    ctx: Ctx,
    agentId: string,
    start: number,
    end: number,
    name: string,
    summary: string,
    ok = true,
    label?: string,
  ): void => {
    const useId = `${tag}-tu${++useSeq}`;
    const category = categorizeTool(name);
    emit(
      start,
      ctx,
      agentId,
      'tool_start',
      { tool: { name, category, summary, useId }, ...(label ? { label } : {}) },
      `tool:${useId}:start`,
    );
    emit(
      end,
      ctx,
      agentId,
      'tool_end',
      { tool: { name, category, ok, useId } },
      `tool:${useId}:end`,
    );
  };

  const session = (name: string): Ctx => ({
    sessionId: `${tag}-${name}`,
    cwd: `/home/demo/${name}`,
  });
  const agent = (role: string): string => `${tag}-${role}`;

  const spawn = (ctx: Ctx, at: number, role: string): string => {
    const id = agent(role);
    // The orchestrator calls the crew member over, then the crew member is created.
    tool(ctx, ORCHESTRATOR_ID, at - 0.6, at, 'Agent', role, true, role);
    emit(at, ctx, id, 'agent_spawn', { label: role }, 'spawn');
    return id;
  };

  // ── Project 1: planning ──────────────────────────────────────────────
  const p1 = session('moonbase-planner');
  emit(0, p1, ORCHESTRATOR_ID, 'session_start');
  emit(0.4, p1, ORCHESTRATOR_ID, 'user_prompt');
  tool(p1, ORCHESTRATOR_ID, 0.8, 1.6, 'TodoWrite', '3 tasks');
  const researcher = spawn(p1, 2.4, 'researcher');
  tool(p1, researcher, 4, 6.5, 'WebSearch', 'lunar habitat power options');
  tool(p1, researcher, 7, 9.5, 'WebFetch', 'docs.example.com');
  tool(p1, researcher, 10, 12.5, 'Read', 'requirements.md');
  tool(p1, researcher, 13, 15.5, 'WebSearch', 'regolith radiation shielding');
  tool(p1, researcher, 16, 18.5, 'Read', 'notes.md');
  tool(p1, researcher, 19, 21.5, 'WebFetch', 'wiki.example.org');
  tool(p1, researcher, 22, 23.5, 'Write', 'research-summary.md');
  emit(24.5, p1, researcher, 'agent_finish', {}, 'finish');
  emit(25.5, p1, ORCHESTRATOR_ID, 'user_prompt');
  const planner = spawn(p1, 27, 'planner');
  tool(p1, planner, 28.5, 31, 'Read', 'research-summary.md');
  tool(p1, planner, 31.5, 36, 'Edit', 'roadmap.md');
  tool(p1, planner, 36.5, 39, 'TodoWrite', '5 tasks');
  emit(40, p1, planner, 'agent_finish', {}, 'finish');
  emit(41, p1, ORCHESTRATOR_ID, 'idle');

  // ── Project 2: coding ────────────────────────────────────────────────
  const p2 = session('rocket-app');
  emit(1, p2, ORCHESTRATOR_ID, 'session_start');
  emit(1.4, p2, ORCHESTRATOR_ID, 'user_prompt');
  tool(p2, ORCHESTRATOR_ID, 1.8, 3, 'Grep', 'useAuth');
  const fe = spawn(p2, 4, 'frontend-dev');
  const be = spawn(p2, 4.8, 'backend-dev');
  const tw = spawn(p2, 5.6, 'test-writer');

  tool(p2, fe, 6.5, 8.5, 'Read', 'App.tsx');
  tool(p2, fe, 9, 10.5, 'Grep', 'useAuth');
  tool(p2, fe, 11, 14.5, 'Edit', 'Login.tsx');
  tool(p2, fe, 15, 17, 'Edit', 'auth.ts');
  // Needs permission to run the build; waits ~12 s, then carries on.
  emit(17.5, p2, fe, 'waiting_for_user', {
    tool: { name: 'Bash', category: 'execute', summary: 'npm run build' },
  });
  tool(p2, fe, 29.5, 33, 'Bash', 'npm run build');
  emit(34, p2, fe, 'agent_finish', {}, 'finish');

  tool(p2, be, 7, 9, 'Read', 'server.ts');
  tool(p2, be, 9.5, 13, 'Edit', 'routes.ts');
  tool(p2, be, 13.5, 18, 'Bash', 'npm test', false);
  tool(p2, be, 18.5, 20, 'Read', 'routes.ts');
  tool(p2, be, 20.5, 23, 'Edit', 'routes.ts');
  tool(p2, be, 23.5, 27, 'Bash', 'npm test');
  emit(28, p2, be, 'agent_finish', {}, 'finish');

  tool(p2, tw, 6.5, 8, 'Glob', '**/*.test.ts');
  tool(p2, tw, 8.5, 10.5, 'Read', 'auth.test.ts');
  tool(p2, tw, 11, 14.5, 'Write', 'login.test.ts');
  tool(p2, tw, 15, 19, 'Bash', 'npm test -- login', false);
  emit(19.5, p2, tw, 'agent_error');

  tool(p2, ORCHESTRATOR_ID, 35, 37, 'Bash', 'git status');
  emit(38, p2, ORCHESTRATOR_ID, 'idle');

  // ── Project 3: appears live mid-demo ─────────────────────────────────
  const p3 = session('asteroid-tools');
  emit(25, p3, ORCHESTRATOR_ID, 'session_start');
  emit(25.4, p3, ORCHESTRATOR_ID, 'user_prompt');
  const refactorer = spawn(p3, 26.5, 'refactorer');
  const docs = spawn(p3, 27.5, 'doc-writer');
  tool(p3, refactorer, 28, 30, 'Grep', 'TODO');
  tool(p3, refactorer, 30.5, 33, 'Read', 'parser.ts');
  tool(p3, refactorer, 33.5, 38, 'Edit', 'parser.ts');
  tool(p3, refactorer, 38.5, 42, 'Bash', 'npm run lint');
  emit(43, p3, refactorer, 'agent_finish', {}, 'finish');
  tool(p3, docs, 29, 32, 'WebFetch', 'docs.example.com');
  tool(p3, docs, 32.5, 37, 'Write', 'README.md');
  emit(38, p3, docs, 'agent_finish', {}, 'finish');
  emit(44, p3, ORCHESTRATOR_ID, 'idle');

  // ── Wrap up: sessions end, seats empty, crew back in the lounge ──────
  emit(52, p1, ORCHESTRATOR_ID, 'session_end');
  emit(54, p2, ORCHESTRATOR_ID, 'session_end');
  emit(56, p3, ORCHESTRATOR_ID, 'session_end');

  return steps.sort((a, b) => a.at - b.at);
}
