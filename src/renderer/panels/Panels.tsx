import { useEffect, useMemo, useState } from 'preact/hooks';
import type { StationStatus } from '@shared/ipc';
import type { StationSnapshot } from '@shared/types';
import { agentRows, clockTime, elapsed, projectRows, STATUS_TEXT } from './model';

const LOG_DISPLAY_CAP = 300;

export interface PanelsProps {
  snap: StationSnapshot;
  status: StationStatus | null;
  selected?: string;
  onFocusProject: (projectId: string) => void;
  onSelectAgent: (agentKey?: string) => void;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Section(props: { title: string; count?: number; children: preact.ComponentChildren }) {
  return (
    <details class="wsc-section" open>
      <summary>
        <span>{props.title}</span>
        {props.count !== undefined && <span class="wsc-count">{props.count}</span>}
      </summary>
      {props.children}
    </details>
  );
}

function StatusBar({ snap, status }: { snap: StationSnapshot; status: StationStatus | null }) {
  const conn = !status
    ? 'starting…'
    : status.demo
      ? 'demo mode'
      : status.port !== undefined
        ? `listening on 127.0.0.1:${status.port}`
        : 'event server offline';
  const state = !status ? 'off' : status.demo ? 'demo' : status.port !== undefined ? 'on' : 'off';
  return (
    <div class="wsc-statusbar">
      <span class={`wsc-dot wsc-conn-${state}`} />
      <span class="wsc-conn">{conn}</span>
      <span class="wsc-events">{snap.eventsReceived} events</span>
    </div>
  );
}

export function Panels({ snap, status, selected, onFocusProject, onSelectAgent }: PanelsProps) {
  const now = useNow(1000);
  const projects = useMemo(() => projectRows(snap), [snap]);
  const agents = useMemo(() => agentRows(snap), [snap]);
  const [projectFilter, setProjectFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');

  const agentOptions = agents.filter((a) => !projectFilter || a.agent.projectId === projectFilter);
  const filterAgent = agentOptions.find((a) => a.key === agentFilter);
  const log = useMemo(() => {
    const out = [];
    for (let i = snap.log.length - 1; i >= 0 && out.length < LOG_DISPLAY_CAP; i--) {
      const e = snap.log[i]!;
      if (projectFilter && e.projectId !== projectFilter) continue;
      if (
        filterAgent &&
        (e.sessionId !== filterAgent.agent.sessionId || e.agentId !== filterAgent.agent.id)
      ) {
        continue;
      }
      out.push(e);
    }
    return out;
  }, [snap, projectFilter, filterAgent]);

  const projectName = (id: string): string => snap.projects[id]?.name ?? '?';

  return (
    <div class="wsc-panels">
      <StatusBar snap={snap} status={status} />

      <Section title="Projects" count={projects.length}>
        {projects.length === 0 ? (
          <p class="wsc-empty">No projects yet. Start Claude Code in a folder.</p>
        ) : (
          <ul class="wsc-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button class="wsc-row" type="button" onClick={() => onFocusProject(p.id)}>
                  <span class="wsc-name">{p.name}</span>
                  <span class="wsc-counts">
                    <span class="wsc-c-working" title="working">
                      ▶{p.working}
                    </span>
                    <span class="wsc-c-waiting" title="waiting for you">
                      ⚑{p.waiting}
                    </span>
                    <span class="wsc-c-done" title="done">
                      ✓{p.done}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Crew" count={agents.length}>
        {agents.length === 0 ? (
          <p class="wsc-empty">Nobody on shift.</p>
        ) : (
          <ul class="wsc-list">
            {agents.map(({ key, agent, name, projectName: proj }) => (
              <li key={key}>
                <button
                  class={`wsc-row wsc-agent${selected === key ? ' is-selected' : ''}`}
                  type="button"
                  aria-pressed={selected === key}
                  onClick={() => onSelectAgent(selected === key ? undefined : key)}
                >
                  <span class={`wsc-dot wsc-s-${agent.status}`} title={STATUS_TEXT[agent.status]} />
                  <span class="wsc-agent-main">
                    <span class="wsc-name">{name}</span>
                    <span class="wsc-sub">
                      {proj} · {STATUS_TEXT[agent.status]}
                      {agent.currentTool &&
                        ` · ${agent.currentTool.name}${agent.currentTool.summary ? ` ${agent.currentTool.summary}` : ''}`}
                    </span>
                  </span>
                  <span class="wsc-agent-meta">
                    <span title="time on this step">{elapsed(now - agent.stepStartedAt)}</span>
                    <span title="tool calls">{agent.toolCalls}×</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Activity">
        <div class="wsc-filters">
          <select
            aria-label="Filter by project"
            value={projectFilter}
            onChange={(e) => {
              setProjectFilter((e.target as HTMLSelectElement).value);
              setAgentFilter('');
            }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by agent"
            value={filterAgent ? agentFilter : ''}
            onChange={(e) => setAgentFilter((e.target as HTMLSelectElement).value)}
          >
            <option value="">All agents</option>
            {agentOptions.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
                {projectFilter ? '' : ` (${a.projectName})`}
              </option>
            ))}
          </select>
        </div>
        {log.length === 0 ? (
          <p class="wsc-empty">No activity yet.</p>
        ) : (
          <ol class="wsc-log">
            {log.map((e) => (
              <li key={e.id} class={`wsc-log-${e.kind}`}>
                <span class="wsc-time">{clockTime(e.ts)}</span>
                <span class="wsc-log-text">
                  <span class="wsc-log-who">
                    {projectFilter ? '' : `${projectName(e.projectId)} › `}
                    {e.agentId === 'orchestrator'
                      ? 'orchestrator'
                      : (snap.agents[`${e.sessionId}:${e.agentId}`]?.label ?? 'agent')}
                  </span>{' '}
                  {e.text}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
