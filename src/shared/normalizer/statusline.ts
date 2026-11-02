// Claude Code status line input → PlanLimits. The ONLY place that knows that format.
// WSC's status line bridge (plugin/statusline/statusline.mjs) forwards just
// `{ session_id, rate_limits }`; a full status line payload is accepted too, and everything but
// `rate_limits` is ignored. Documented fields (docs/claude-code-integration.md):
//   rate_limits.five_hour.used_percentage  number, 0–100
//   rate_limits.five_hour.resets_at        unix epoch seconds
//   rate_limits.seven_day.{used_percentage, resets_at}
// Each window may be absent. Total: malformed input yields null and never throws.
import type { PlanLimits, PlanWindow } from '../dashboardTypes';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Epoch seconds are below this; larger numbers are already milliseconds. */
const MS_THRESHOLD = 1e12;

function resetMs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < MS_THRESHOLD ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return resetMs(n);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function planWindow(v: unknown): PlanWindow | undefined {
  if (!isRec(v)) return undefined;
  const pct = v['used_percentage'];
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = resetMs(v['resets_at']);
  if (resetsAt === undefined) return undefined;
  return { usedPct: Math.max(0, Math.min(1000, pct)), resetsAt };
}

/** Plan limits from a status line payload, or null when it carries no usable window. */
export function normalizeRateLimits(raw: unknown, receivedAt: number): PlanLimits | null {
  try {
    if (!isRec(raw) || !isRec(raw['rate_limits'])) return null;
    const rl = raw['rate_limits'];
    const fiveHour = planWindow(rl['five_hour']);
    const sevenDay = planWindow(rl['seven_day']);
    if (!fiveHour && !sevenDay) return null;
    const out: PlanLimits = { updatedAt: receivedAt };
    if (fiveHour) out.fiveHour = fiveHour;
    if (sevenDay) out.sevenDay = sevenDay;
    return out;
  } catch {
    return null;
  }
}
