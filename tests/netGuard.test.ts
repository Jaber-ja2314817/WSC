import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from '../src/main/netGuard';

describe('isAllowedUrl', () => {
  it.each([
    'http://127.0.0.1:47821/v1/health',
    'http://localhost:5173/',
    'ws://localhost:5173/',
    'file:///app/index.html',
    'data:image/png;base64,AAAA',
    'devtools://devtools/bundled/inspector.html',
  ])('allows local %s', (url) => expect(isAllowedUrl(url)).toBe(true));

  it.each([
    'https://example.com/',
    'http://192.168.1.10/',
    'http://127.0.0.1.evil.com/',
    'ftp://localhost/',
    'not a url',
  ])('blocks %s', (url) => expect(isAllowedUrl(url)).toBe(false));
});
