import { useMemo, useState } from 'preact/hooks';
import type { ConnectionTest, WscApi } from '@shared/ipc';
import { manualHookSnippet, PLUGIN_INSTALL } from './hookSnippet';

export interface FirstRunProps {
  api: WscApi;
  onClose: () => void;
}

function CopyBlock({ api, text, label }: { api: WscApi; text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="wsc-copy">
      <pre tabIndex={0}>{text}</pre>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void api.copyText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function FirstRun({ api, onClose }: FirstRunProps) {
  const snippet = useMemo(manualHookSnippet, []);
  const [test, setTest] = useState<ConnectionTest | 'running' | null>(null);

  return (
    <div
      class="wsc-firstrun-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wsc-fr-title"
    >
      <div class="wsc-firstrun">
        <button class="wsc-close" type="button" aria-label="Close setup" onClick={onClose}>
          ×
        </button>
        <h1 id="wsc-fr-title">Welcome aboard WSC</h1>
        <p>
          WSC watches your Claude Code agents and shows them as a pixel-art crew. It only listens on
          this computer. It never sends prompts, never calls a model and costs nothing extra.
        </p>

        <h2>1. Install the Claude Code plugin</h2>
        <p>In Claude Code, run these two commands:</p>
        <CopyBlock api={api} text={PLUGIN_INSTALL.join('\n')} label="plugin install commands" />
        <p class="wsc-muted">
          Then type <code>/station</code> (or <code>/wsc:station</code>) any time to open this
          window.
        </p>

        <details>
          <summary>No plugins? Add the hooks by hand</summary>
          <p>
            Merge this into the <code>"hooks"</code> section of your user settings file,{' '}
            <code>~/.claude/settings.json</code>. Don't replace the file, and keep any hooks you
            already have. Replace <code>&lt;path-to-wsc&gt;</code> with the folder you cloned WSC
            into.
          </p>
          <CopyBlock api={api} text={snippet} label="hook settings" />
        </details>

        <h2>2. Check the connection</h2>
        <div class="wsc-actions">
          <button
            type="button"
            disabled={test === 'running'}
            onClick={() => {
              setTest('running');
              void api
                .testConnection()
                .then(setTest, () => setTest({ ok: false, error: 'Failed.' }));
            }}
          >
            Test connection
          </button>
          <span role="status" class="wsc-test-result">
            {test === 'running' && 'Checking…'}
            {test &&
              test !== 'running' &&
              test.ok &&
              `Listening on 127.0.0.1:${test.port}. Now run Claude Code.`}
            {test && test !== 'running' && !test.ok && (test.error ?? 'Not connected.')}
          </span>
        </div>

        <h2>3. Or just look around</h2>
        <div class="wsc-actions">
          <button
            type="button"
            class="wsc-primary"
            onClick={() => {
              void api.startDemo();
              onClose();
            }}
          >
            Watch a demo
          </button>
          <span class="wsc-muted">Real activity takes over as soon as it arrives.</span>
        </div>
      </div>
    </div>
  );
}
