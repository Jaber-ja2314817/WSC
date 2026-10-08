import type { WscApi } from '../shared/ipc';

declare global {
  interface Window {
    wsc: WscApi;
  }
}
