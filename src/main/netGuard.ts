// Enforces "local only": every request that isn't local or bundled is cancelled.
import type { Session } from 'electron';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALWAYS_OK = new Set(['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:']);

export function isAllowedUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (ALWAYS_OK.has(u.protocol)) return true;
  return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && LOCAL_HOSTS.has(u.hostname);
}

export function installNetGuard(ses: Session): void {
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    cb({ cancel: !isAllowedUrl(details.url) });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}
