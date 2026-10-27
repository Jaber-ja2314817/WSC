// User settings: zod schema, defaults and per-field tolerant parsing. Pure (main + renderer).
import { z } from 'zod';
import type { ToolCategory } from './types';

export const TOOL_CATEGORIES = [
  'read',
  'search',
  'write',
  'execute',
  'web',
  'delegate',
  'plan',
  'mcp',
  'other',
] as const satisfies readonly ToolCategory[];

const ToolCategorySchema = z.enum(TOOL_CATEGORIES);

const price = z.number().min(0).max(10_000);
const ModelPriceSchema = z.object({
  input: price,
  output: price,
  cacheWrite: price,
  cacheRead: price,
});

export const SettingsSchema = z.object({
  /** Theme id (built-in or user theme folder name). */
  theme: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    .default('spaceship'),
  /** Preferred ingest port; applied on next launch (falls back to a free port). */
  port: z.number().int().min(1024).max(65535).default(47821),
  loungeSize: z.number().int().min(2).max(24).default(6),
  reportFrequency: z.enum(['minimal', 'normal', 'chatty']).default('normal'),
  /** Working/thinking agents with no events for this long show as stale. */
  staleSeconds: z.number().int().min(10).max(3600).default(90),
  /** Ended sessions stay on screen this long before their seat empties. */
  lingerSeconds: z.number().int().min(0).max(600).default(10),
  /** Projects with no activity for this long are dimmed. */
  idleProjectMinutes: z.number().int().min(1).max(1440).default(30),
  statusBubbles: z.boolean().default(true),
  catchphraseBubbles: z.boolean().default(true),
  /** Longer (still redacted) tool summaries. Off by default for privacy. */
  showFullToolDetails: z.boolean().default(false),
  /** Native OS notification when an agent waits for you. */
  notifications: z.boolean().default(false),
  /** 'system' follows prefers-reduced-motion. */
  reduceMotion: z.enum(['system', 'on', 'off']).default('system'),
  /** Reserved: no sounds ship yet. */
  sound: z.boolean().default(false),
  launchAtLogin: z.boolean().default(false),
  /** Extra tool name → category mappings (checked before the built-in table). */
  toolCategoryOverrides: z
    .record(z.string().min(1).max(128), ToolCategorySchema)
    .refine((r) => Object.keys(r).length <= 200, 'at most 200 overrides')
    .default({}),

  // ── dashboard + auto-launch ────────────────────────────────────────────────
  /** The SessionStart hook starts WSC when it isn't running (read by plugin/hooks/forward.mjs). */
  launchOnSessionStart: z.boolean().default(true),
  /** Bring the window to the front when a new session starts. Off: never steal focus. */
  focusOnSessionStart: z.boolean().default(false),
  /** The dashboard column is expanded (collapsed shows a slim rail). */
  dashboardOpen: z.boolean().default(true),
  /** Transcripts modified within this many days are read at startup for usage totals. */
  lookbackDays: z.number().int().min(1).max(30).default(7),
  /** A session with no activity for this long shows as idle. */
  idleMinutes: z.number().int().min(1).max(240).default(10),
  /** Length of the rolling usage window (an estimate of Claude's usage window). */
  usageWindowHours: z.number().min(1).max(24).default(5),
  /** User-calibrated token limits; null shows raw totals. */
  windowTokenLimit: z.number().int().positive().max(1e12).nullable().default(null),
  weeklyTokenLimit: z.number().int().positive().max(1e13).nullable().default(null),
  /** Show a redacted, truncated preview of the latest prompt. Off by default for privacy. */
  showPromptPreview: z.boolean().default(false),
  /** USD per million tokens, keyed by a model-id substring. Empty: no cost estimate. */
  prices: z
    .record(z.string().min(1).max(128), ModelPriceSchema)
    .refine((r) => Object.keys(r).length <= 50, 'at most 50 prices')
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

type FieldKey = keyof Settings;
const FIELDS = Object.keys(SettingsSchema.shape) as FieldKey[];

/**
 * Parse settings from untrusted JSON. Each field is validated on its own: a bad value falls back
 * to that field's default instead of discarding the whole file. Unknown keys are dropped.
 * For `toolCategoryOverrides` and `prices`, invalid entries are dropped individually.
 */
export function parseSettings(raw: unknown): Settings {
  return applyFields(DEFAULT_SETTINGS, raw);
}

/** Merge a partial update into current settings; invalid fields keep their current value. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  return applyFields(current, patch);
}

function applyFields(base: Settings, raw: unknown): Settings {
  const src =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...base };
  for (const key of FIELDS) {
    if (!(key in src)) continue;
    if (key === 'toolCategoryOverrides') {
      out[key] = parseOverrides(src[key]);
      continue;
    }
    if (key === 'prices') {
      out[key] = parsePrices(src[key]);
      continue;
    }
    const r = SettingsSchema.shape[key].safeParse(src[key]);
    if (r.success) out[key] = r.data;
  }
  return out as Settings;
}

function parseOverrides(v: unknown): Record<string, ToolCategory> {
  const out: Record<string, ToolCategory> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [name, cat] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= 200) break;
    if (!name || name.length > 128) continue;
    const r = ToolCategorySchema.safeParse(cat);
    if (r.success) out[name] = r.data;
  }
  return out;
}

const MAX_PRICES = 50;

function parsePrices(v: unknown): Settings['prices'] {
  const out: Settings['prices'] = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [key, price] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PRICES) break;
    if (!key || key.length > 128) continue;
    const r = ModelPriceSchema.safeParse(price);
    if (r.success) out[key] = r.data;
  }
  return out;
}
