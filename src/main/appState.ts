// Tiny persisted app flags (never event contents). Lives next to the runtime file in app data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlanLimits } from '@shared/dashboardTypes';
import { normalizeRateLimits } from '@shared/normalizer';
import { appDataDir } from './runtimeFile';

export interface AppFlags {
  /** A real hook event has reached this install at least once (hides the first-run screen). */
  hasReceivedEvents: boolean;
  /**
   * Last plan usage the status line bridge reported (two percentages and reset times), so the
   * bars show right away after a restart. Never any other status line content.
   */
  planLimits?: PlanLimits;
}

const DEFAULT_FLAGS: AppFlags = { hasReceivedEvents: false };

export function appFlagsPath(): string {
  return process.env['WSC_STATE_FILE'] || join(appDataDir(), 'state.json');
}

export function readAppFlags(): AppFlags {
  try {
    const raw = JSON.parse(readFileSync(appFlagsPath(), 'utf8')) as Partial<AppFlags>;
    const flags: AppFlags = { hasReceivedEvents: raw.hasReceivedEvents === true };
    const limits = readPlanLimits(raw.planLimits);
    if (limits) flags.planLimits = limits;
    return flags;
  } catch {
    return { ...DEFAULT_FLAGS };
  }
}

export function writeAppFlags(flags: AppFlags): void {
  try {
    const file = appFlagsPath();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(flags), { mode: 0o600 });
  } catch {
    // Non-critical: worst case the first-run screen shows again.
  }
}

/** Re-validates persisted plan limits (stored in our own shape, epoch ms). */
function readPlanLimits(v: unknown): PlanLimits | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const p = v as PlanLimits;
  const toRaw = (w: PlanLimits['fiveHour']) =>
    w ? { used_percentage: w.usedPct, resets_at: w.resetsAt } : undefined;
  const updatedAt = Number.isFinite(p.updatedAt) ? p.updatedAt : 0;
  return (
    normalizeRateLimits(
      { rate_limits: { five_hour: toRaw(p.fiveHour), seven_day: toRaw(p.sevenDay) } },
      updatedAt,
    ) ?? undefined
  );
}
