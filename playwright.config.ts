import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // One Electron app at a time: the app holds a single-instance lock.
  workers: 1,
  reporter: 'list',
});
