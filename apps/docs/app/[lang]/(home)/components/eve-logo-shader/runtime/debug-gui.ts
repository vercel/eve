// Owns the optional lil-gui transition debugger for the Eve hero.
// INVARIANT: ?debug gate and window.__eveLogoTransitionDebugGui lifecycle are preserved.
// Imported only by index.tsx runtime startup.

export type EveTransitionDebugGui = {
  destroy(): void;
};

export type EveTransitionDebugState = {
  overrideEnabled: boolean;
  progress: number;
  gridScaleMultiplier: number;
  glyphScale: number;
  durationSeconds: number;
  paintDecayPerFrame120: number;
  diffusionAmount: number;
  diffusionJitter: number;
  brushRadius: number;
  brushStrength: number;
  visualizePaintBuffer: boolean;
};

declare global {
  interface Window {
    __eveLogoTransitionDebugGui?: EveTransitionDebugGui;
  }
}

export function destroyTransitionDebugGui(gui: EveTransitionDebugGui | undefined) {
  if (!gui) return;
  if (window.__eveLogoTransitionDebugGui === gui) {
    delete window.__eveLogoTransitionDebugGui;
  }
  gui.destroy();
}

export async function setupTransitionDebugGui({
  transitionDebug,
  isCancelled,
  isDisposed,
  onReady,
}: {
  transitionDebug: EveTransitionDebugState;
  isCancelled: () => boolean;
  isDisposed: () => boolean;
  onReady: (gui: EveTransitionDebugGui) => void;
}) {
  if (!new URLSearchParams(window.location.search).has("debug")) return;
  const { GUI } = await import("lil-gui");
  if (isCancelled() || isDisposed()) return;
  window.__eveLogoTransitionDebugGui?.destroy();
  const gui = new GUI({ title: "Eve logo imprint" });
  let guiDestroyed = false;
  const guiHandle: EveTransitionDebugGui = {
    destroy() {
      if (guiDestroyed) return;
      guiDestroyed = true;
      gui.destroy();
    },
  };
  onReady(guiHandle);
  window.__eveLogoTransitionDebugGui = guiHandle;
  gui.add(transitionDebug, "overrideEnabled").name("Override imprint");
  gui.add(transitionDebug, "progress", 0, 1, 0.001).name("Imprint progress");
  const imprint = gui.addFolder("Imprint");
  imprint.add(transitionDebug, "gridScaleMultiplier", 0.5, 2, 0.01).name("Grid scale multiplier");
  imprint.add(transitionDebug, "glyphScale", 0.5, 2.5, 0.01).name("Glyph scale");
  imprint.open();
  const paint = gui.addFolder("Paint");
  paint
    .add(transitionDebug, "paintDecayPerFrame120", 0.002, 0.08, 0.001)
    .name("Decay/frame @120fps");
  paint.add(transitionDebug, "diffusionAmount", 0, 24, 0.1).name("Diffusion (1/s)");
  paint.add(transitionDebug, "diffusionJitter", 0, 4, 0.01).name("Diffusion jitter");
  paint.add(transitionDebug, "brushRadius", 1, 8, 0.1).name("Brush radius (cells)");
  paint.add(transitionDebug, "brushStrength", 4, 32, 0.1).name("Brush strength (1/s)");
  paint.add(transitionDebug, "visualizePaintBuffer").name("Visualize paint buffer");
  paint.open();
  gui.add(transitionDebug, "durationSeconds", 0.05, 2, 0.01).name("Transition duration (s)");
}
