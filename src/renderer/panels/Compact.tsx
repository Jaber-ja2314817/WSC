// Compact mode chrome: a draggable title strip plus a slim list of active agents.
import { render } from 'preact';
import type { WscApi } from '@shared/ipc';
import type { StationSnapshot } from '@shared/types';
import { agentRows, STATUS_TEXT } from './model';

const ACTIVE = new Set(['working', 'thinking', 'waiting', 'error', 'stale']);

function CompactStrip({ snap, api }: { snap: StationSnapshot; api: WscApi }) {
  const active = agentRows(snap).filter((r) => ACTIVE.has(r.agent.status));
  const waiting = active.filter((r) => r.agent.status === 'waiting').length;
  return (
    <div class="wsc-compact">
      <div class="wsc-compact-bar">
        <span class="wsc-compact-title">
          WSC{waiting > 0 ? ` · ${waiting} need${waiting === 1 ? 's' : ''} you` : ''}
        </span>
        <button
          type="button"
          class="wsc-compact-btn"
          title="Back to the full window (⌘/Ctrl+Shift+M)"
          aria-label="Expand to full window"
          onClick={() => void api.setWindowMode('normal')}
        >
          ⤢
        </button>
      </div>
      <ul class="wsc-compact-list" aria-label="Active agents">
        {active.length === 0 ? (
          <li class="wsc-muted">All quiet.</li>
        ) : (
          active.map(({ key, agent, name, projectName }) => (
            <li key={key} title={`${name} · ${projectName} · ${STATUS_TEXT[agent.status]}`}>
              <span class={`wsc-dot wsc-s-${agent.status}`} />
              {/* Orchestrators are all called "orchestrator": label them by project instead. */}
              <span class="wsc-compact-name">
                {agent.isOrchestrator ? `★ ${projectName}` : name}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

export function mountCompact(
  el: HTMLElement,
  api: WscApi,
): { update(snap: StationSnapshot): void } {
  return {
    update(snap) {
      render(<CompactStrip snap={snap} api={api} />, el);
    },
  };
}
