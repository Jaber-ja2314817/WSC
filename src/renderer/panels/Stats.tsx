// Stats view of the dashboard column: usage statistics for a date range, in the spirit of
// Claude Code's /stats. Pull only: asks main for a StatsSnapshot when shown and polls while
// shown. Renders only StatsSnapshot fields (numbers, model ids, project names).
import { Component } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WscApi } from '@shared/ipc';
import { STATS_RANGES, type StatsRange, type StatsSnapshot } from '@shared/statsTypes';
import {
  SHARE_CELLS,
  STATS_RANGE_LABEL,
  dayBars,
  dayReading,
  heatCellPx,
  heatGrid,
  hourBars,
  keptStats,
  hourSpan,
  rangeTitle,
  statsFootnote,
  statsModelRows,
  statsPhase,
  statsPollDelay,
  statsProjectRows,
  statsTiles,
  type Bar,
  type HeatCell,
  type StatsMemory,
} from './statsModel';
import { formatTokens } from './dashboardModel';
import './stats.css';

/** Kept by mountDashboard so the last numbers survive tab switches and collapsing. */
export type { StatsMemory };

export interface StatsPaneProps {
  api: WscApi;
  range: StatsRange;
  onRange: (range: StatsRange) => void;
  memory: StatsMemory;
  /** The station plays the demo (from StationStatus); undefined until known. */
  demo: boolean | undefined;
}

const DAY_CHART_HEIGHT = 72;
const HOUR_CHART_HEIGHT = 64;
/** The bar chart's baseline: `.wsc-stats-bars { border-bottom: 2px }` in stats.css. */
const BAR_BASELINE_PX = 2;
/** Width of the weekday heads left of the heatmap. */
const WDAY_W = 24;

function Cells({ on, total, label }: { on: number; total: number; label: string }) {
  const cells = [];
  for (let i = 0; i < total; i++) cells.push(<span key={i} class={i < on ? 'on' : ''} />);
  return (
    <div class="wsc-dash-bar wsc-stats-share" role="img" aria-label={label}>
      {cells}
    </div>
  );
}

/** Keys that move a roving focus along a list of `n` items; undefined for other keys. */
function stepKey(key: string, i: number, n: number, step = 1, cross = 0): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return Math.min(n - 1, i + step);
    case 'ArrowLeft':
      return Math.max(0, i - step);
    case 'ArrowDown':
      return cross ? Math.min(n - 1, i + cross) : undefined;
    case 'ArrowUp':
      return cross ? Math.max(0, i - cross) : undefined;
    case 'Home':
      return 0;
    case 'End':
      return n - 1;
    default:
      return undefined;
  }
}

/** A row of single-colour bars (days of the week, hours of the day) with a hover readout. */
function BarChart(props: {
  bars: Bar[];
  height: number;
  label: string;
  hint: string;
  testId: string;
  initial: number;
}) {
  const { bars, height } = props;
  const [shown, setShown] = useState<number | null>(null);
  const [active, setActive] = useState(props.initial);
  const ref = useRef<HTMLDivElement>(null);
  const cur = Math.min(active, bars.length - 1);
  const bar = shown !== null ? bars[shown] : undefined;

  const onKey = (e: KeyboardEvent): void => {
    const next = stepKey(e.key, cur, bars.length);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
    setShown(next);
    ref.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus();
  };

  return (
    <div class="wsc-stats-chart" data-testid={props.testId}>
      <div class="wsc-stats-readout" aria-hidden="true">
        {bar ? <strong>{bar.reading}</strong> : <span class="wsc-muted">{props.hint}</span>}
      </div>
      <div
        ref={ref}
        class="wsc-stats-bars"
        role="group"
        aria-label={props.label}
        style={{
          // border-box: the baseline border comes on top, so the tallest bar fits exactly.
          height: `${height + BAR_BASELINE_PX}px`,
          gridTemplateColumns: `repeat(${bars.length}, 1fr)`,
        }}
        onKeyDown={onKey}
        onMouseLeave={() => setShown(null)}
      >
        {bars.map((b, i) => (
          <span
            key={b.key}
            data-i={i}
            class={`wsc-stats-barcol${b.mark ? ' is-mark' : ''}${shown === i ? ' is-hover' : ''}`}
            role="img"
            aria-label={b.reading}
            title={b.reading}
            tabIndex={i === cur ? 0 : -1}
            onMouseEnter={() => setShown(i)}
            onFocus={() => {
              setActive(i);
              setShown(i);
            }}
            onBlur={() => setShown(null)}
          >
            {b.px > 0 && <span class="wsc-stats-barfill" style={{ height: `${b.px}px` }} />}
          </span>
        ))}
      </div>
      <div
        class="wsc-stats-axis"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${bars.length}, 1fr)` }}
      >
        {bars.map((b) => (
          <span key={b.key}>{b.label}</span>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ snap }: { snap: StatsSnapshot }) {
  const grid = heatGrid(snap.days);
  const { cell, gap } = heatCellPx(grid.weeks);
  const n = snap.days.length;
  const [active, setActive] = useState(n - 1);
  const [shown, setShown] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const cur = Math.max(0, Math.min(active, n - 1));
  const shownDay = shown !== null ? snap.days[shown] : undefined;
  if (grid.weeks === 0) return null;

  const onKey = (e: KeyboardEvent): void => {
    // Left/right move a week, up/down a day; days are contiguous, so ±7 is a week.
    const next = stepKey(e.key, cur, n, 7, 1);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
    setShown(next);
    ref.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus();
  };

  const pitch = cell + gap;
  // Weekday heads only where a row is tall enough to hold the text.
  const wdayW = cell >= 8 ? WDAY_W : 0;
  const rowStyle = { gap: `${gap}px`, height: `${cell}px` };
  const renderCell = (c: HeatCell | null, w: number) =>
    c ? (
      <span
        key={w}
        role="gridcell"
        data-i={c.index}
        class={`wsc-stats-cell wsc-heat-${c.level}${shown === c.index ? ' is-hover' : ''}`}
        style={{ width: `${cell}px`, height: `${cell}px` }}
        aria-label={c.reading}
        title={c.reading}
        tabIndex={c.index === cur ? 0 : -1}
        onMouseEnter={() => setShown(c.index)}
        onFocus={() => {
          setActive(c.index);
          setShown(c.index);
        }}
        onBlur={() => setShown(null)}
      />
    ) : (
      <span
        key={w}
        role="presentation"
        class="wsc-stats-cell is-out"
        style={{ width: `${cell}px`, height: `${cell}px` }}
      />
    );

  return (
    <div class="wsc-stats-heat" data-testid="stats-heatmap">
      <div class="wsc-stats-readout" aria-hidden="true">
        {shownDay ? (
          <strong>{dayReading(shownDay)}</strong>
        ) : (
          <span class="wsc-muted">hover or focus a day for details</span>
        )}
      </div>
      <div
        class="wsc-stats-months"
        aria-hidden="true"
        style={{ marginLeft: `${wdayW > 0 ? wdayW + gap : 0}px` }}
      >
        {grid.months.map((m) => (
          <span key={`${m.week}-${m.label}`} style={{ left: `${m.week * pitch}px` }}>
            {m.label}
          </span>
        ))}
      </div>
      <div
        ref={ref}
        class="wsc-stats-grid"
        role="grid"
        aria-label="Activity by day: weeks as columns, weekdays as rows"
        style={{ gap: `${gap}px` }}
        onKeyDown={onKey}
        onMouseLeave={() => setShown(null)}
      >
        {grid.rows.map((row, r) => (
          <div key={r} class="wsc-stats-row" role="row" style={rowStyle}>
            {wdayW > 0 && (
              <span
                class="wsc-stats-wday"
                aria-hidden="true"
                style={{ width: `${wdayW}px`, lineHeight: `${cell}px` }}
              >
                {grid.rowLabels[r]}
              </span>
            )}
            {row.map(renderCell)}
          </div>
        ))}
      </div>
      <div class="wsc-stats-legend" aria-hidden="true">
        <span>less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} class={`wsc-stats-cell wsc-heat-${l}`} />
        ))}
        <span>more</span>
      </div>
    </div>
  );
}

function Activity({ snap }: { snap: StatsSnapshot }) {
  if (snap.days.length === 0) return null;
  if (snap.range === '7d') {
    return (
      <BarChart
        bars={dayBars(snap.days, DAY_CHART_HEIGHT)}
        height={DAY_CHART_HEIGHT}
        label="Tokens per day"
        hint="hover or focus a day for details"
        testId="stats-days"
        initial={snap.days.length - 1}
      />
    );
  }
  return <Heatmap key={snap.range} snap={snap} />;
}

function Tiles({ snap }: { snap: StatsSnapshot }) {
  return (
    <div class="wsc-stats-tiles" data-testid="stats-tiles">
      {statsTiles(snap).map((t) => (
        <div
          key={t.key}
          class={`wsc-stats-tile${t.wide ? ' is-wide' : ''}`}
          data-testid={`stats-tile-${t.key}`}
        >
          <span class="wsc-stats-tile-label">{t.label}</span>
          <span class="wsc-stats-tile-value" title={t.value}>
            {t.value}
          </span>
          {t.sub && (
            <span class="wsc-stats-tile-sub" title={t.sub}>
              {t.sub}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Models({ snap }: { snap: StatsSnapshot }) {
  const rows = statsModelRows(snap.models);
  if (rows.length === 0) return null;
  return (
    <section class="wsc-dash-section" aria-label="Models">
      <h3>Models</h3>
      <ul class="wsc-stats-list">
        {rows.map((m) => (
          <li key={m.model} class="wsc-stats-model">
            <div class="wsc-stats-line">
              <span class="wsc-stats-name" title={m.model}>
                {m.name}
              </span>
              <span class="wsc-stats-num">{m.total}</span>
              <span class="wsc-stats-pct">{m.pct}</span>
            </div>
            <Cells on={m.cells} total={SHARE_CELLS} label={`${m.name}: ${m.pct} of tokens`} />
            <div class="wsc-stats-split">
              <span>
                in <strong>{m.input}</strong>
              </span>
              <span>
                out <strong>{m.output}</strong>
              </span>
              <span>
                cache write <strong>{m.cacheWrite}</strong>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Projects({ snap }: { snap: StatsSnapshot }) {
  const rows = statsProjectRows(snap.projects);
  if (rows.length === 0) return null;
  return (
    <section class="wsc-dash-section" aria-label="Top projects">
      <h3>Top projects</h3>
      <ul class="wsc-stats-list">
        {rows.map((p) => (
          <li key={p.id} class="wsc-stats-project">
            <div class="wsc-stats-line">
              <span class="wsc-stats-name" title={p.name}>
                {p.name}
              </span>
              <span class="wsc-stats-num">{p.total}</span>
            </div>
            <Cells on={p.cells} total={SHARE_CELLS} label={`${p.name}: ${p.total} tokens`} />
            <div class="wsc-stats-split">
              <span>{p.sessions}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Hours({ snap }: { snap: StatsSnapshot }) {
  const bars = hourBars(snap.byHour, snap.peakHour, HOUR_CHART_HEIGHT);
  const peak = snap.peakHour;
  return (
    <section class="wsc-dash-section" aria-label="Tokens per hour of day">
      <h3>Tokens per hour of day</h3>
      <BarChart
        bars={bars}
        height={HOUR_CHART_HEIGHT}
        label="Tokens per hour of day"
        hint={
          peak !== undefined
            ? `peak ${hourSpan(peak)} · ${formatTokens(snap.byHour[peak] ?? 0)} tokens`
            : 'no tokens yet'
        }
        testId="stats-hours"
        initial={peak ?? 0}
      />
    </section>
  );
}

function StatsView(props: StatsPaneProps) {
  const { api, range, memory, demo } = props;
  const [snap, setSnap] = useState<StatsSnapshot | null>(() => keptStats(memory, demo));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // The station switched between demo and live: the old numbers are the other mode's, so
    // drop them and ask again right away (main answers for the mode it is in now).
    if (memory.demo !== demo) {
      memory.snap = null;
      memory.demo = demo;
      setSnap(null);
    }
    if (typeof api.getStats !== 'function') {
      setFailed(true);
      return;
    }
    let live = true;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = (ms: number): void => {
      stopTimer();
      if (live && !document.hidden) timer = setTimeout(load, ms);
    };
    const done = (s: StatsSnapshot | null): void => {
      inflight = false;
      // A response for a range the user has already left (or after unmount) is ignored.
      if (!live) return;
      if (s) {
        memory.snap = s;
        memory.demo = demo;
        setSnap(s);
      }
      setFailed(!s);
      schedule(statsPollDelay(s));
    };
    function load(): void {
      stopTimer();
      if (!live || inflight || document.hidden) return;
      inflight = true;
      let p: Promise<StatsSnapshot | null>;
      try {
        p = api.getStats(range);
      } catch {
        p = Promise.reject(new Error('getStats failed'));
      }
      p.then(
        (s) => done(s ?? null),
        () => done(null),
      );
    }
    const onVisibility = (): void => {
      if (document.hidden) stopTimer();
      else load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    load();
    return () => {
      live = false;
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, range, memory, demo]);

  const phase = statsPhase(snap, failed);
  // The previous snapshot stays up while the newly picked range loads.
  const switching = !failed && snap !== null && snap.range !== range;

  return (
    <div class="wsc-stats" data-testid="dash-stats" aria-busy={phase === 'loading' || switching}>
      <div class="wsc-stats-top">
        <div class="wsc-stats-ranges" role="group" aria-label="Date range">
          {STATS_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              class="wsc-stats-range"
              aria-pressed={r === range}
              data-range={r}
              onClick={() => r !== range && props.onRange(r)}
            >
              {STATS_RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <span class="wsc-stats-title">{rangeTitle(snap?.range ?? range, snap)}</span>
      </div>
      {(phase === 'scanning' || switching) && (
        <div class="wsc-stats-scan" data-testid="stats-scanning" role="status">
          <span class="wsc-stats-scan-dot" aria-hidden="true" />
          {switching ? `loading ${STATS_RANGE_LABEL[range]}…` : 'still reading history'}
        </div>
      )}
      {phase === 'unavailable' && <p class="wsc-dash-empty">Stats are not available.</p>}
      {phase === 'loading' && (
        <p class="wsc-dash-empty" role="status">
          Reading your history…
        </p>
      )}
      {phase === 'empty' && snap && (
        <>
          <p class="wsc-dash-empty">No activity in this range yet.</p>
          <p class="wsc-dash-note wsc-stats-foot">{statsFootnote(snap)}</p>
        </>
      )}
      {(phase === 'scanning' || phase === 'full') && snap && (
        <>
          <Tiles snap={snap} />
          {snap.days.length > 0 && (
            <section class="wsc-dash-section" aria-label="Activity">
              <h3>Activity</h3>
              <Activity snap={snap} />
            </section>
          )}
          <Models snap={snap} />
          <Hours snap={snap} />
          <Projects snap={snap} />
          <p class="wsc-dash-note wsc-stats-foot">{statsFootnote(snap)}</p>
        </>
      )}
    </div>
  );
}

/**
 * The Stats tab. Re-renders of the dashboard column (a push every 500 ms while agents work)
 * leave it alone unless the range, the station mode or the API changes; its own polling
 * drives its updates.
 */
export class StatsPane extends Component<StatsPaneProps> {
  override shouldComponentUpdate(next: StatsPaneProps): boolean {
    return (
      next.range !== this.props.range ||
      next.demo !== this.props.demo ||
      next.api !== this.props.api ||
      next.memory !== this.props.memory ||
      next.onRange !== this.props.onRange
    );
  }

  override render() {
    return <StatsView {...this.props} />;
  }
}
