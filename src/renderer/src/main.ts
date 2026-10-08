// Keeps the strict CSP (no 'unsafe-eval'): Pixi uses precompiled shaders/uniform syncs.
import 'pixi.js/unsafe-eval';
import { Application, Graphics, TextureStyle } from 'pixi.js';

// Crisp pixels: must be set before any texture is created.
TextureStyle.defaultOptions.scaleMode = 'nearest';

async function boot(): Promise<void> {
  const stage = document.getElementById('stage');
  const panel = document.getElementById('panel');
  if (!stage || !panel) return;

  const app = new Application();
  await app.init({
    resizeTo: stage,
    antialias: false,
    roundPixels: true,
    background: '#0b0e1a',
  });
  stage.appendChild(app.canvas);

  // M1 placeholder: a single pixel-art command table in the center.
  const table = new Graphics().rect(0, 0, 48, 24).fill(0x2b3a67).rect(4, 4, 40, 16).fill(0x5ad1ff);
  table.scale.set(4);
  app.stage.addChild(table);
  const center = (): void => {
    table.position.set(
      Math.round((app.screen.width - table.width) / 2),
      Math.round((app.screen.height - table.height) / 2),
    );
  };
  center();
  app.renderer.on('resize', center);

  const info = await window.wsc.appInfo();
  const snap = await window.wsc.getSnapshot();
  panel.textContent = `${info.name} v${info.version}${info.demo ? ' (demo)' : ''} — ${Object.keys(snap.projects).length} projects`;
}

void boot();
