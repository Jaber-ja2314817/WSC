// Settings tab: every user setting, theme picker, tool mappings, maintenance actions and About.
import { useState } from 'preact/hooks';
import { supportsLoginItem, type ConnectionTest, type WscApi } from '@shared/ipc';
import { TOOL_CATEGORIES, type Settings } from '@shared/settings';
import type { ToolCategory } from '@shared/types';

export interface SettingsPanelProps {
  api: WscApi;
  settings: Settings | null;
  themes: { id: string; name: string; source?: string }[];
  version: string;
}

type Patch = Partial<Settings>;

function Row(props: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <label class="wsc-set-row">
      <span class="wsc-set-label">
        {props.label}
        {props.hint && <span class="wsc-set-hint">{props.hint}</span>}
      </span>
      <span class="wsc-set-control">{props.children}</span>
    </label>
  );
}

function Toggle(props: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <input
      type="checkbox"
      checked={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
    />
  );
}

function NumberInput(props: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      min={props.min}
      max={props.max}
      value={props.value}
      onChange={(e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isInteger(v) && v >= props.min && v <= props.max) props.onChange(v);
      }}
    />
  );
}

/** Optional positive integer; empty clears it (null). */
function LimitInput(props: {
  value: number | null;
  max: number;
  label: string;
  onChange: (v: number | null) => void;
}) {
  return (
    <input
      type="number"
      min={1}
      max={props.max}
      step={1000}
      placeholder="none"
      aria-label={props.label}
      class="wsc-set-wide"
      value={props.value ?? ''}
      onChange={(e) => {
        const raw = (e.target as HTMLInputElement).value.trim();
        if (raw === '') return props.onChange(null);
        const v = Number(raw);
        if (Number.isInteger(v) && v >= 1 && v <= props.max) props.onChange(v);
      }}
    />
  );
}

function ToolMappings(props: {
  value: Record<string, ToolCategory>;
  onChange: (v: Record<string, ToolCategory>) => void;
}) {
  const [name, setName] = useState('');
  const [cat, setCat] = useState<ToolCategory>('other');
  const entries = Object.entries(props.value);
  return (
    <div class="wsc-mappings">
      {entries.length === 0 && <p class="wsc-empty">No custom mappings.</p>}
      {entries.map(([tool, c]) => (
        <div class="wsc-mapping" key={tool}>
          <code>{tool}</code>
          <span>→ {c}</span>
          <button
            type="button"
            class="wsc-btn wsc-btn-small"
            aria-label={`Remove mapping for ${tool}`}
            onClick={() => {
              const next = { ...props.value };
              delete next[tool];
              props.onChange(next);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div class="wsc-mapping wsc-mapping-new">
        <input
          type="text"
          placeholder="Tool name, e.g. mcp__db__query"
          value={name}
          maxLength={128}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <select
          value={cat}
          onChange={(e) => setCat((e.target as HTMLSelectElement).value as ToolCategory)}
        >
          {TOOL_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          class="wsc-btn wsc-btn-small"
          disabled={!name.trim()}
          onClick={() => {
            props.onChange({ ...props.value, [name.trim()]: cat });
            setName('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({ api, settings, themes, version }: SettingsPanelProps) {
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [cleared, setCleared] = useState(false);
  if (!settings) return <p class="wsc-empty">Loading settings…</p>;
  const set = (patch: Patch): void => void api.setSettings(patch);

  return (
    <div class="wsc-settings">
      <section class="wsc-section-plain">
        <h3>Look</h3>
        <Row label="Theme">
          <select
            aria-label="Theme"
            value={settings.theme}
            onChange={(e) => set({ theme: (e.target as HTMLSelectElement).value })}
          >
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.source === 'user' ? ' (user)' : ''}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Status bubbles">
          <Toggle value={settings.statusBubbles} onChange={(v) => set({ statusBubbles: v })} />
        </Row>
        <Row label="Catchphrase bubbles">
          <Toggle
            value={settings.catchphraseBubbles}
            onChange={(v) => set({ catchphraseBubbles: v })}
          />
        </Row>
        <Row label="Reduce motion" hint="System follows your OS setting">
          <select
            value={settings.reduceMotion}
            onChange={(e) =>
              set({
                reduceMotion: (e.target as HTMLSelectElement).value as Settings['reduceMotion'],
              })
            }
          >
            <option value="system">System</option>
            <option value="on">On (agents snap)</option>
            <option value="off">Off</option>
          </select>
        </Row>
        <Row label="Sound" hint="Coming soon">
          <Toggle value={settings.sound} disabled onChange={() => {}} />
        </Row>
      </section>

      <section class="wsc-section-plain">
        <h3>Crew</h3>
        <Row label="Lounge size" hint="Idle crew waiting in the lounge">
          <NumberInput
            value={settings.loungeSize}
            min={2}
            max={24}
            onChange={(v) => set({ loungeSize: v })}
          />
        </Row>
        <Row label="Report frequency">
          <select
            value={settings.reportFrequency}
            onChange={(e) =>
              set({
                reportFrequency: (e.target as HTMLSelectElement)
                  .value as Settings['reportFrequency'],
              })
            }
          >
            <option value="minimal">Minimal (errors, waiting)</option>
            <option value="normal">Normal (+ finished)</option>
            <option value="chatty">Chatty (+ every few tools)</option>
          </select>
        </Row>
        <Row label="Stale after (s)" hint="No events → “?” indicator">
          <NumberInput
            value={settings.staleSeconds}
            min={10}
            max={3600}
            onChange={(v) => set({ staleSeconds: v })}
          />
        </Row>
        <Row label="Seat linger (s)" hint="After a session ends">
          <NumberInput
            value={settings.lingerSeconds}
            min={0}
            max={600}
            onChange={(v) => set({ lingerSeconds: v })}
          />
        </Row>
        <Row label="Dim idle projects (min)">
          <NumberInput
            value={settings.idleProjectMinutes}
            min={1}
            max={1440}
            onChange={(v) => set({ idleProjectMinutes: v })}
          />
        </Row>
      </section>

      <section class="wsc-section-plain">
        <h3>Privacy &amp; alerts</h3>
        <Row label="Show full tool details" hint="Longer summaries, secrets still redacted">
          <Toggle
            value={settings.showFullToolDetails}
            onChange={(v) => set({ showFullToolDetails: v })}
          />
        </Row>
        <Row label="Notify when an agent needs you" hint="Native OS notification">
          <Toggle value={settings.notifications} onChange={(v) => set({ notifications: v })} />
        </Row>
        {supportsLoginItem(navigator.userAgent) && (
          <Row label="Launch at login">
            <Toggle value={settings.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} />
          </Row>
        )}
        <Row label="Port" hint="Applies on next launch">
          <NumberInput
            value={settings.port}
            min={1024}
            max={65535}
            onChange={(v) => set({ port: v })}
          />
        </Row>
      </section>

      <section class="wsc-section-plain">
        <h3>Dashboard &amp; launch</h3>
        <Row label="Show dashboard" hint="Left column; « / » collapses it">
          <Toggle value={settings.dashboardOpen} onChange={(v) => set({ dashboardOpen: v })} />
        </Row>
        <Row label="Launch on session start" hint="A new Claude Code session opens WSC">
          <Toggle
            value={settings.launchOnSessionStart}
            onChange={(v) => set({ launchOnSessionStart: v })}
          />
        </Row>
        <Row label="Focus on session start" hint="Off: never steals focus">
          <Toggle
            value={settings.focusOnSessionStart}
            onChange={(v) => set({ focusOnSessionStart: v })}
          />
        </Row>
        <Row label="Idle after (min)" hint="No activity → session shows idle">
          <NumberInput
            value={settings.idleMinutes}
            min={1}
            max={240}
            onChange={(v) => set({ idleMinutes: v })}
          />
        </Row>
        <Row label="Usage window (h)" hint="Rolling window length (estimate)">
          <NumberInput
            value={settings.usageWindowHours}
            min={1}
            max={24}
            onChange={(v) => set({ usageWindowHours: v })}
          />
        </Row>
        <Row label="History (days)" hint="Transcripts read at startup">
          <NumberInput
            value={settings.lookbackDays}
            min={1}
            max={30}
            onChange={(v) => set({ lookbackDays: v })}
          />
        </Row>
        <Row label="Window token limit" hint="Empty = show raw totals">
          <LimitInput
            label="Window token limit"
            value={settings.windowTokenLimit}
            max={1e12}
            onChange={(v) => set({ windowTokenLimit: v })}
          />
        </Row>
        <Row label="Weekly token limit" hint="Empty = show raw totals">
          <LimitInput
            label="Weekly token limit"
            value={settings.weeklyTokenLimit}
            max={1e13}
            onChange={(v) => set({ weeklyTokenLimit: v })}
          />
        </Row>
        <Row
          label="Show prompt preview"
          hint="Privacy: shows a short, redacted snippet of your latest prompt. Kept in memory only."
        >
          <Toggle
            value={settings.showPromptPreview}
            onChange={(v) => set({ showPromptPreview: v })}
          />
        </Row>
        <p class="wsc-set-note">
          Limits are your own calibration — exact remaining quota is only in Claude Code&apos;s
          /usage. Cost estimates need per-model <code>prices</code> (USD per million tokens) in
          settings.json
          {Object.keys(settings.prices).length > 0
            ? ` — ${Object.keys(settings.prices).length} configured.`
            : ' — none configured.'}
        </p>
      </section>

      <section class="wsc-section-plain">
        <h3>Custom tool mappings</h3>
        <ToolMappings
          value={settings.toolCategoryOverrides}
          onChange={(v) => set({ toolCategoryOverrides: v })}
        />
      </section>

      <section class="wsc-section-plain">
        <h3>Station</h3>
        <div class="wsc-actions">
          <button
            type="button"
            class="wsc-btn"
            onClick={() => {
              void api.clearIdleProjects().then(() => setCleared(true));
            }}
          >
            {cleared ? 'Idle projects cleared' : 'Clear idle projects'}
          </button>
          <button type="button" class="wsc-btn" onClick={() => void api.startDemo()}>
            Watch a demo
          </button>
          <button
            type="button"
            class="wsc-btn"
            onClick={() => void api.testConnection().then(setTest)}
          >
            Test connection
          </button>
          <button type="button" class="wsc-btn" onClick={() => void api.setWindowMode('compact')}>
            Compact mode
          </button>
        </div>
        {test && (
          <p class={test.ok ? 'wsc-ok' : 'wsc-err'} role="status">
            {test.ok ? `Listening on 127.0.0.1:${test.port}.` : test.error}
          </p>
        )}
      </section>

      <section class="wsc-section-plain wsc-about">
        <h3>About</h3>
        <p>
          <strong>WSC</strong> — Work Space Claude · v{version}
        </p>
        <p>Watch-only, local-only, no telemetry. MIT licensed.</p>
        <p class="wsc-muted">
          Not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of
          Anthropic.
        </p>
      </section>
    </div>
  );
}
