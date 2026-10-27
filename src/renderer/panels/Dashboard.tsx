// Dashboard column (left of the stage): usage window, session cards, session detail, hourly chart.
// Renders only DashboardSnapshot / TimelineStep fields (already sanitized by main).
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
  DashboardSnapshot,
  SessionSummary,
  TimelineStep,
  UsageStats,
} from '@shared/dashboardTypes';
import { tokenTotal } from '@shared/dashboardTypes';
import type { WscApi } from '@shared/ipc';
import type { Settings } from '@shared/settings';
import {
  CHART_TOP_N,
  DASHBOARD_AUTO_COLLAPSE_PX,
  clockHM,
  filledCells,
  formatCountdown,
  formatDuration,
  sessionDurationMs,
  formatRate,
  formatTokens,
  formatUsd,
  hourLabel,
  modelRows,
  needsYou,
  percent,
  railReading,
  relativeTime,
  segmentHeights,
  shortModel,
  stackHourly,
  statusLabel,
  statusTone,
  SUBAGENT_STATUS_TONE,
  timelineIcon,
  usageLevel,
  usageRows,
} from './dashboardModel';
import { clockTime } from './model';
import './dashboard.css';

export interface MountDashboardOptions {
  api?: WscApi;
  /** A session card was (de)selected in the dashboard. */
  onSelectSession: (sessionId: string | undefined) => void;
}

export interface DashboardHandle {
  /** Select a session from outside (the station); no callback is fired. */
  select(sessionId: string | undefined): void;
  setSettings(settings: Settings): void;
}

const BAR_CELLS = 20;
const CHART_HEIGHT = 96;

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Own 1 s timer so only this text node re-renders every second. */
function Countdown({ end }: { end: number }) {
  const now = useNow(1000);
  return <>{formatCountdown(end - now)}</>;
}

function PixelBar({ pct, label }: { pct: number; label: string }) {
  const level = usageLevel(pct);
  const filled = filledCells(pct, BAR_CELLS);
  const cells = [];
  for (let i = 0; i < BAR_CELLS; i++) cells.push(<span key={i} class={i < filled ? 'on' : ''} />);
  return (
    <div class="wsc-dash-meter">
      <div
        class={`wsc-dash-bar wsc-lvl-${level}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, pct)}
      >
        {cells}
      </div>
      <span class={`wsc-dash-pct wsc-lvl-${level}`}>
        {level === 'danger' ? '! ' : level === 'warn' ? '▲ ' : ''}
        {pct}%
      </span>
    </div>
  );
}

function UsageTop({ usage, scanning }: { usage: UsageStats; scanning: boolean }) {
  const winPct = percent(usage.windowTotal, usage.windowLimit);
  const weekPct = percent(usage.weeklyTotal, usage.weeklyLimit);
  const noLimits = winPct === undefined && weekPct === undefined;
  return (
    <section class="wsc-dash-usage" aria-label="Usage window">
      <div class="wsc-dash-kicker">
        <span>{usage.windowHours}h window</span>
        {scanning && <span class="wsc-dash-scan">scanning history…</span>}
      </div>
      <div class="wsc-dash-hero">
        <span class="wsc-dash-big" data-testid="dash-window-total">
          {formatTokens(usage.windowTotal)}
        </span>
        <span class="wsc-dash-unit">
          tokens
          {usage.windowLimit ? ` / ${formatTokens(usage.windowLimit)}` : ''}
        </span>
      </div>
      <div class="wsc-dash-cache" title="Re-reads of already cached context; not counted above">
        + {formatTokens(usage.windowUsage.cacheRead)} cache reads (not counted)
      </div>
      {winPct !== undefined && <PixelBar pct={winPct} label="Window usage" />}
      <div class="wsc-dash-facts">
        <span>
          {usage.windowEnd !== undefined ? (
            <>
              resets in{' '}
              <strong>
                <Countdown end={usage.windowEnd} />
              </strong>
            </>
          ) : (
            'no active window'
          )}
        </span>
        <span>
          burn <strong>{formatRate(usage.burnPerMin)}</strong>
        </span>
        {usage.windowEnd !== undefined && (
          <span>
            at reset ≈ <strong>{formatTokens(usage.projectedTotal)}</strong>
          </span>
        )}
        {usage.windowCostUsd !== undefined && (
          <span>
            cost ≈ <strong>{formatUsd(usage.windowCostUsd)}</strong>
          </span>
        )}
      </div>
      <div class="wsc-dash-week">
        <span>
          week <strong>{formatTokens(usage.weeklyTotal)}</strong>
          {usage.weeklyLimit ? ` / ${formatTokens(usage.weeklyLimit)}` : ''}
          {usage.weeklyCostUsd !== undefined && ` · ≈ ${formatUsd(usage.weeklyCostUsd)}`}
        </span>
      </div>
      {weekPct !== undefined && <PixelBar pct={weekPct} label="Weekly usage" />}
      {noLimits && <p class="wsc-dash-hint">Set a limit in Settings to see a %.</p>}
      <p class="wsc-dash-note">
        Estimate from local transcripts — exact remaining quota is only in Claude Code&apos;s
        /usage.
      </p>
    </section>
  );
}

function SessionCard(props: {
  s: SessionSummary;
  now: number;
  selected: boolean;
  onClick: () => void;
}) {
  const { s, now } = props;
  const tone = statusTone(s.status);
  const total = tokenTotal(s.usage);
  return (
    <li>
      <button
        type="button"
        class={`wsc-dash-card wsc-tone-${tone}${props.selected ? ' is-selected' : ''}`}
        aria-pressed={props.selected}
        data-session={s.shortId}
        onClick={props.onClick}
      >
        <span class="wsc-dash-card-head">
          <span class={`wsc-dash-light wsc-bg-${tone}${s.status === 'waiting' ? ' blink' : ''}`} />
          <span class={`wsc-dash-status wsc-fg-${tone}`}>{statusLabel(s.status)}</span>
          <span class="wsc-dash-tokens" title="tokens this session">
            {formatTokens(total)}
          </span>
        </span>
        <span class="wsc-dash-project">{s.projectName}</span>
        <span class="wsc-dash-sub">
          {s.gitBranch && <span class="wsc-dash-branch">⎇ {s.gitBranch}</span>}
          <span>#{s.shortId}</span>
          {s.models.length > 0 && <span>{s.models.map(shortModel).join(', ')}</span>}
        </span>
        {s.currentStep && <span class="wsc-dash-step">{s.currentStep}</span>}
        {s.promptPreview && <span class="wsc-dash-prompt">“{s.promptPreview}”</span>}
        <span class="wsc-dash-times">
          <span title="started">▶ {clockHM(s.startedAt)}</span>
          <span title="last activity">{relativeTime(s.lastActivityAt, now)}</span>
          <span title="duration">⏱ {formatDuration(sessionDurationMs(s, now))}</span>
          {s.costUsd !== undefined && <span>≈ {formatUsd(s.costUsd)}</span>}
        </span>
        {s.subagents.length > 0 && (
          <span class="wsc-dash-chips" aria-label={`${s.subagents.length} subagents`}>
            <span class="wsc-dash-chipcount">{s.subagents.length} sub</span>
            {s.subagents.map((a) => (
              <span key={a.id} class="wsc-dash-chip" title={`${a.label} · ${a.status}`}>
                <span class={`wsc-dash-dot wsc-bg-${SUBAGENT_STATUS_TONE[a.status]}`} />
                {a.label}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}

function Timeline({ api, session }: { api: WscApi; session: SessionSummary }) {
  const [steps, setSteps] = useState<TimelineStep[] | null>(null);
  useEffect(() => {
    let live = true;
    const get = api.getTimeline?.bind(api);
    if (!get) {
      setSteps([]);
      return;
    }
    get(session.id).then(
      (list) => live && setSteps(list),
      () => live && setSteps([]),
    );
    return () => {
      live = false;
    };
  }, [api, session.id, session.lastActivityAt]);
  if (!steps) return <p class="wsc-dash-empty">Loading timeline…</p>;
  if (steps.length === 0) return <p class="wsc-dash-empty">No steps recorded yet.</p>;
  return (
    <ol class="wsc-dash-timeline">
      {steps.map((st) => {
        const failed = st.ok === false || st.kind === 'error';
        return (
          <li key={st.id} class={`wsc-tl-${st.kind}${failed ? ' is-failed' : ''}`}>
            <span class="wsc-dash-time">{clockTime(st.ts)}</span>
            <span class="wsc-tl-icon" aria-hidden="true">
              {timelineIcon(st.kind, st.ok)}
            </span>
            <span class="wsc-tl-text">
              {st.agentLabel && <span class="wsc-tl-who">{st.agentLabel} › </span>}
              {st.text}
              {failed && st.kind === 'tool' && <span class="wsc-tl-fail"> failed</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Detail({ api, session }: { api: WscApi; session: SessionSummary }) {
  const models = modelRows(session.usageByModel);
  return (
    <section class="wsc-dash-section" aria-label="Session detail">
      <h3>
        {session.projectName} · #{session.shortId}
      </h3>
      <table class="wsc-dash-table">
        <tbody>
          {usageRows(session.usage).map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{formatTokens(r.value)}</td>
            </tr>
          ))}
          <tr class="wsc-dash-total">
            <th scope="row">total</th>
            <td>{formatTokens(tokenTotal(session.usage))}</td>
          </tr>
          <tr class="wsc-dash-cache" title="Re-reads of already cached context; not in the total">
            <th scope="row">cache read</th>
            <td>{formatTokens(session.usage.cacheRead)}</td>
          </tr>
        </tbody>
      </table>
      {models.length > 0 && (
        <table class="wsc-dash-table wsc-dash-models">
          <thead>
            <tr>
              <th scope="col">model</th>
              <th scope="col">in</th>
              <th scope="col">out</th>
              <th scope="col">cache w</th>
              <th scope="col">total</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.model}>
                <th scope="row">{shortModel(m.model)}</th>
                <td>{formatTokens(m.usage.input)}</td>
                <td>{formatTokens(m.usage.output)}</td>
                <td>{formatTokens(m.usage.cacheCreation)}</td>
                <td>{formatTokens(m.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h4>Timeline</h4>
      <Timeline key={session.id} api={api} session={session} />
    </section>
  );
}

function HourlyChart({ usage }: { usage: UsageStats }) {
  const slotsRef = useRef<Record<string, number>>({});
  const [hover, setHover] = useState<number | null>(null);
  const chart = stackHourly(usage.hourly, usage.projectNames, CHART_TOP_N, slotsRef.current);
  slotsRef.current = chart.slots;
  if (chart.bars.length === 0 || chart.max <= 0) {
    return <p class="wsc-dash-empty">No token usage in the last 24 h.</p>;
  }
  const bar = hover !== null ? chart.bars[hover] : undefined;
  const slotClass = (slot: number): string => (slot < 0 ? 'wsc-ser-other' : `wsc-ser-${slot}`);
  return (
    <div class="wsc-dash-chart">
      <div class="wsc-dash-readout" aria-live="polite">
        {bar ? (
          <>
            <strong>
              {hourLabel(bar.start)} · {formatTokens(bar.total)}
            </strong>
            {chart.series.map((s, i) =>
              (bar.values[i] ?? 0) > 0 ? (
                <span key={s.id}>
                  {' '}
                  · {s.name} {formatTokens(bar.values[i]!)}
                </span>
              ) : null,
            )}
          </>
        ) : (
          <span class="wsc-muted">peak {formatTokens(chart.max)}/h · hover a bar for details</span>
        )}
      </div>
      <div
        class="wsc-dash-plot"
        // Room for the 2 px gaps between stacked segments on top of the scaled bar height.
        style={{ height: `${CHART_HEIGHT + 2 * Math.max(0, chart.series.length - 1)}px` }}
      >
        {chart.bars.map((b, i) => {
          const heights = segmentHeights(b.values, chart.max, CHART_HEIGHT);
          return (
            <div
              key={b.start}
              class={`wsc-dash-col${hover === i ? ' is-hover' : ''}`}
              title={`${hourLabel(b.start)} · ${formatTokens(b.total)} tokens`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {chart.series.map((s, j) =>
                heights[j]! > 0 ? (
                  <span
                    key={s.id}
                    class={`wsc-dash-seg ${slotClass(s.slot)}`}
                    style={{ height: `${heights[j]}px` }}
                  />
                ) : null,
              )}
            </div>
          );
        })}
      </div>
      <div class="wsc-dash-axis" aria-hidden="true">
        <span>{hourLabel(chart.bars[0]!.start)}</span>
        <span>{hourLabel(chart.bars[Math.floor(chart.bars.length / 2)]!.start)}</span>
        <span>now</span>
      </div>
      <ul class="wsc-dash-legend">
        {chart.series.map((s) => (
          <li key={s.id}>
            <span class={`wsc-dash-swatch ${slotClass(s.slot)}`} />
            <span class="wsc-dash-legend-name">{s.name}</span>
            <span class="wsc-dash-legend-val">{formatTokens(s.total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Rail(props: { dash: DashboardSnapshot | null; onExpand: () => void }) {
  const reading = railReading(props.dash?.usage);
  const waiting = needsYou(props.dash?.sessions);
  return (
    <div class="wsc-dash-rail">
      <button
        type="button"
        class="wsc-dash-toggle"
        title="Show dashboard"
        aria-label="Show dashboard"
        aria-expanded={false}
        onClick={props.onExpand}
      >
        »
      </button>
      <span class={`wsc-dash-rail-val wsc-lvl-${reading.level}`} title="usage window">
        {reading.text}
      </span>
      {waiting && (
        <span
          class="wsc-dash-light wsc-bg-waiting blink"
          title="A session is waiting for you"
          aria-label="A session is waiting for you"
        />
      )}
    </div>
  );
}

function DashboardView(props: {
  api: WscApi;
  dash: DashboardSnapshot | null;
  available: boolean;
  selected?: string;
  onSelect: (id: string | undefined) => void;
  onCollapse: () => void;
}) {
  const now = useNow(5000);
  const { dash } = props;
  const sel = props.selected ? dash?.sessions.find((s) => s.id === props.selected) : undefined;
  return (
    <div class="wsc-dash">
      <div class="wsc-dash-header">
        <span class="wsc-dash-title">Dashboard</span>
        {needsYou(dash?.sessions) && (
          <span class="wsc-dash-alert">
            <span class="wsc-dash-light wsc-bg-waiting blink" /> needs you
          </span>
        )}
        <button
          type="button"
          class="wsc-dash-toggle"
          title="Hide dashboard"
          aria-label="Hide dashboard"
          aria-expanded={true}
          onClick={props.onCollapse}
        >
          «
        </button>
      </div>
      {!dash ? (
        <p class="wsc-dash-empty">
          {props.available ? 'Waiting for usage data…' : 'Dashboard data is not available.'}
        </p>
      ) : (
        <>
          <UsageTop usage={dash.usage} scanning={dash.scanning} />
          <section class="wsc-dash-section" aria-label="Sessions">
            <h3>
              Sessions <span class="wsc-muted">{dash.sessions.length}</span>
            </h3>
            {dash.sessions.length === 0 ? (
              <p class="wsc-dash-empty">No recent sessions.</p>
            ) : (
              <ul class="wsc-dash-cards">
                {dash.sessions.map((s) => (
                  <SessionCard
                    key={s.id}
                    s={s}
                    now={now}
                    selected={s.id === props.selected}
                    onClick={() => props.onSelect(s.id === props.selected ? undefined : s.id)}
                  />
                ))}
              </ul>
            )}
          </section>
          {sel && <Detail api={props.api} session={sel} />}
          <section class="wsc-dash-section" aria-label="Tokens per hour">
            <h3>Last 24 h · tokens per hour</h3>
            <HourlyChart usage={dash.usage} />
          </section>
        </>
      )}
    </div>
  );
}

export function mountDashboard(el: HTMLElement, opts: MountDashboardOptions): DashboardHandle {
  const api = opts.api ?? window.wsc;
  const available = typeof api.getDashboard === 'function';
  let dash: DashboardSnapshot | null = null;
  let selected: string | undefined;
  let persistedOpen = true;
  let narrow = window.innerWidth < DASHBOARD_AUTO_COLLAPSE_PX;
  /** Local open/closed choice made while the window is narrow (not persisted). */
  let manual: boolean | null = null;

  const isOpen = (): boolean => manual ?? (persistedOpen && !narrow);

  const setOpen = (open: boolean): void => {
    if (narrow) manual = open;
    else {
      manual = null;
      persistedOpen = open;
      void api.setSettings({ dashboardOpen: open }).catch(() => {});
    }
    draw();
  };

  const onSelect = (id: string | undefined): void => {
    selected = id;
    draw();
    opts.onSelectSession(id);
  };

  function draw(): void {
    const open = isOpen();
    el.classList.toggle('is-collapsed', !open);
    render(
      open ? (
        <DashboardView
          api={api}
          dash={dash}
          available={available}
          selected={selected}
          onSelect={onSelect}
          onCollapse={() => setOpen(false)}
        />
      ) : (
        <Rail dash={dash} onExpand={() => setOpen(true)} />
      ),
      el,
    );
  }

  window.addEventListener('resize', () => {
    const next = window.innerWidth < DASHBOARD_AUTO_COLLAPSE_PX;
    if (next === narrow) return;
    narrow = next;
    manual = null;
    draw();
  });

  const setDash = (d: DashboardSnapshot | null): void => {
    if (!d) return;
    dash = d;
    draw();
  };
  if (available) {
    void api.getDashboard().then(setDash, () => {});
    api.onDashboard?.(setDash);
  }
  draw();

  return {
    select(id) {
      if (selected === id) return;
      selected = id;
      draw();
      if (id && isOpen()) {
        el.querySelector('.wsc-dash-card.is-selected')?.scrollIntoView({ block: 'nearest' });
      }
    },
    setSettings(s) {
      if (s.dashboardOpen === persistedOpen) return;
      persistedOpen = s.dashboardOpen;
      if (!narrow) manual = null;
      draw();
    },
  };
}
