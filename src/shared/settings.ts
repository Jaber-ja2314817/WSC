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
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

type FieldKey = keyof Settings;
const FIELDS = Object.keys(SettingsSchema.shape) as FieldKey[];

/**
 * Parse settings from untrusted JSON. Each field is validated on its own: a bad value falls back
 * to that field's default instead of discarding the whole file. Unknown keys are dropped.
 * For `toolCategoryOverrides`, invalid entries are dropped individually.
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
