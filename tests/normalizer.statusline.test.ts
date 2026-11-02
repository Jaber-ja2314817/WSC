// Status line `rate_limits` → PlanLimits. Payloads are SYNTHETIC.
import { describe, expect, it } from 'vitest';
import { normalizeRateLimits } from '../src/shared/normalizer';

const NOW = 1_800_000_000_000;
const RESET_S = 1_800_010_000;

describe('normalizeRateLimits', () => {
  it('reads both windows; resets_at seconds become epoch ms', () => {
    const raw = {
      session_id: 'sess-1',
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: RESET_S },
        seven_day: { used_percentage: 41, resets_at: RESET_S + 86_400 },
      },
    };
    expect(normalizeRateLimits(raw, NOW)).toEqual({
      updatedAt: NOW,
      fiveHour: { usedPct: 23.5, resetsAt: RESET_S * 1000 },
      sevenDay: { usedPct: 41, resetsAt: (RESET_S + 86_400) * 1000 },
    });
  });

  it('keeps a lone window and ignores the rest of a full status line payload', () => {
    const raw = {
      cwd: '/home/user/proj',
      model: { id: 'fake-model' },
      cost: { total_cost_usd: 1.2 },
      rate_limits: { seven_day: { used_percentage: 7, resets_at: RESET_S } },
    };
    expect(normalizeRateLimits(raw, NOW)).toEqual({
      updatedAt: NOW,
      sevenDay: { usedPct: 7, resetsAt: RESET_S * 1000 },
    });
  });

  it('accepts millisecond and ISO reset times', () => {
    const ms = normalizeRateLimits(
      { rate_limits: { five_hour: { used_percentage: 1, resets_at: RESET_S * 1000 } } },
      NOW,
    );
    expect(ms?.fiveHour?.resetsAt).toBe(RESET_S * 1000);
    const iso = new Date(RESET_S * 1000).toISOString();
    const parsed = normalizeRateLimits(
      { rate_limits: { five_hour: { used_percentage: 1, resets_at: iso } } },
      NOW,
    );
    expect(parsed?.fiveHour?.resetsAt).toBe(RESET_S * 1000);
  });

  it('clamps negative percentages to 0', () => {
    const r = normalizeRateLimits(
      { rate_limits: { five_hour: { used_percentage: -5, resets_at: RESET_S } } },
      NOW,
    );
    expect(r?.fiveHour?.usedPct).toBe(0);
  });

  it('returns null for malformed or empty input, never throws', () => {
    const bad: unknown[] = [
      null,
      'x',
      42,
      [],
      {},
      { rate_limits: null },
      { rate_limits: [] },
      { rate_limits: {} },
      { rate_limits: { five_hour: { used_percentage: '50', resets_at: RESET_S } } },
      { rate_limits: { five_hour: { used_percentage: Number.NaN, resets_at: RESET_S } } },
      { rate_limits: { five_hour: { used_percentage: 5 } } },
      { rate_limits: { five_hour: { used_percentage: 5, resets_at: 'soon' } } },
      { rate_limits: { five_hour: { used_percentage: 5, resets_at: -1 } } },
    ];
    for (const raw of bad) expect(normalizeRateLimits(raw, NOW)).toBeNull();
    const hostile = {
      get rate_limits(): never {
        throw new Error('boom');
      },
    };
    expect(normalizeRateLimits(hostile, NOW)).toBeNull();
  });
});
