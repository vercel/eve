import { clamp, clamp01, easeInOutCubic, lerp } from "phase/ease";
import type { MutableRefObject } from "react";
import { evePointerInteractionMode, mobileAutoEnvYaw } from "../mobile-motion";
import type { ImprintRenderOptions, RenderControls } from "../render";
import {
  getCanvasLogicalSize,
  resizeCanvas,
  type CanvasLayoutRef,
  type DevicePixelRatioRef,
} from "./canvas-sizing";
import type { EveTransitionDebugState } from "./debug-gui";
import type { ControlsRef, HeroRuntimeState } from "./state";

// Owns the Eve hero draw step and canvas reveal sequencing.
// INVARIANT: dataset markers, paint movement gating, and fallback-on-error behavior are preserved.
// Imported only by index.tsx's single effect and driven by phase's useLoop.

const ENV_YAW_LERP_SPEED = 3;
export const AGENTS_ENV_YAW_LERP_SPEED = 3;
const AGENTS_ENV_YAW_OFFSET = -Math.PI * 0.1;
const ASCII_MOUSE_LERP_SPEED = 6;
const PAINT_MOVEMENT_GRACE_MS = 72;
const CANVAS_FADE_FALLBACK_MS = 800;
const CANVAS_REVEAL_RENDER_COUNT = 3;
const MAX_FRAME_DELTA_SECONDS = 0.05;
export const AGENTS_MAX_FRAME_DELTA_SECONDS = MAX_FRAME_DELTA_SECONDS;

const PROBE_DATASET_WRITE_INTERVAL_MS = 250;

type Renderer = {
  render: (
    target: GPUTextureView,
    controls: RenderControls,
    logicalWidth: number,
    logicalHeight: number,
    imprint?: ImprintRenderOptions,
  ) => void;
};

const IS_PRODUCTION = process.env.NODE_ENV === "production";

type EveHeroFrameLoopProbe = {
  frames: number;
  running: boolean;
  lastFrameAt: number;
};

declare global {
  interface Window {
    __eveHeroFrameLoop?: EveHeroFrameLoopProbe;
  }
}

function getHeroFrameLoopProbe(): EveHeroFrameLoopProbe | undefined {
  if (IS_PRODUCTION) return undefined;
  if (typeof window === "undefined") return undefined;
  if (!window.__eveHeroFrameLoop) {
    window.__eveHeroFrameLoop = {
      frames: 0,
      running: false,
      lastFrameAt: 0,
    };
  }
  return window.__eveHeroFrameLoop;
}

export type DrawLoop = {
  start: () => void;
  stop: () => void;
  step: (frameTime?: number) => void;
  dispose: () => void;
};

export function createDrawLoop({
  state,
  canvas,
  context,
  renderer,
  controlsRef,
  transitionDebug,
  modeTransitionProgressRef,
  targetLogoModeProgressRef,
  targetAgentsEnvYawMixRef,
  defaultMaterial,
  canvasLayoutRef,
  devicePixelRatioRef,
  onCanvasRevealed,
  onFallback,
  onFatalError,
}: {
  state: HeroRuntimeState;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  renderer: Renderer;
  controlsRef: ControlsRef;
  transitionDebug: EveTransitionDebugState;
  modeTransitionProgressRef: MutableRefObject<number>;
  targetLogoModeProgressRef: MutableRefObject<number>;
  targetAgentsEnvYawMixRef: MutableRefObject<number>;
  defaultMaterial: RenderControls["material"];
  canvasLayoutRef: CanvasLayoutRef;
  devicePixelRatioRef: DevicePixelRatioRef;
  onCanvasRevealed: () => void;
  onFallback: () => void;
  onFatalError: () => void;
}) {
  let successfulRenderCount = 0;
  let finishCanvasFade: (() => void) | undefined;
  let running = false;
  const frameLoopProbe = getHeroFrameLoopProbe();
  let lastProbeDatasetWrite = 0;

  const updateFrameLoopProbeDataset = (force = false) => {
    if (!frameLoopProbe) return;
    const now = performance.now();
    if (!force && now - lastProbeDatasetWrite < PROBE_DATASET_WRITE_INTERVAL_MS) return;
    lastProbeDatasetWrite = now;
    canvas.dataset.heroFrames = String(frameLoopProbe.frames);
    canvas.dataset.heroRunning = String(frameLoopProbe.running);
    canvas.dataset.heroLastFrameAt = String(Math.round(frameLoopProbe.lastFrameAt));
  };

  const draw = (frameTime = performance.now()) => {
    if (!running || state.cancelled) return;

    const deltaSeconds = Math.min(
      MAX_FRAME_DELTA_SECONDS,
      Math.max(0, (frameTime - state.previousFrameTime) / 1000),
    );
    state.previousFrameTime = frameTime;
    if (evePointerInteractionMode(state.isCoarsePointer).autoRotateEnvYaw) {
      state.targetMouseEnvYaw = mobileAutoEnvYaw((frameTime - state.autoRotateStartTime) / 1000);
      state.targetMouseEnvPitch = 0;
      state.targetBrushActive = false;
    }
    state.mouseEnvYaw = lerp(
      state.mouseEnvYaw,
      state.targetMouseEnvYaw,
      clamp01(deltaSeconds * ENV_YAW_LERP_SPEED),
    );
    state.mouseEnvPitch = lerp(
      state.mouseEnvPitch,
      state.targetMouseEnvPitch,
      clamp01(deltaSeconds * ENV_YAW_LERP_SPEED),
    );
    state.asciiMouseX = lerp(
      state.asciiMouseX,
      state.targetAsciiMouseX,
      clamp01(deltaSeconds * ASCII_MOUSE_LERP_SPEED),
    );
    state.asciiMouseY = lerp(
      state.asciiMouseY,
      state.targetAsciiMouseY,
      clamp01(deltaSeconds * ASCII_MOUSE_LERP_SPEED),
    );
    state.brushActive = state.targetBrushActive && state.hasBrushCell;
    const targetAgentsEnvYawMix = targetAgentsEnvYawMixRef.current;
    state.agentsEnvYawMix = lerp(
      state.agentsEnvYawMix,
      targetAgentsEnvYawMix,
      clamp01(deltaSeconds * AGENTS_ENV_YAW_LERP_SPEED),
    );
    controlsRef.current.envYaw = state.mouseEnvYaw + state.agentsEnvYawMix * AGENTS_ENV_YAW_OFFSET;
    controlsRef.current.envPitch = state.mouseEnvPitch;

    const devicePixelRatio = resizeCanvas(canvas, canvasLayoutRef, devicePixelRatioRef);
    const { logicalWidth, logicalHeight } = getCanvasLogicalSize(canvas, devicePixelRatio);

    try {
      const transitionDurationSeconds = clamp(transitionDebug.durationSeconds, 0.05, 2);
      modeTransitionProgressRef.current = stepLogoModeProgress(
        modeTransitionProgressRef.current,
        targetLogoModeProgressRef.current,
        deltaSeconds,
        transitionDurationSeconds,
      );
      const animatedMixProgress = easeInOutCubic(clamp01(modeTransitionProgressRef.current));
      const mixProgress = transitionDebug.overrideEnabled
        ? clamp01(transitionDebug.progress)
        : animatedMixProgress;
      const timeSeconds = frameTime / 1000;
      const gridScaleMultiplier = clamp(transitionDebug.gridScaleMultiplier, 0.5, 2);
      state.paintGridScaleMultiplier = gridScaleMultiplier;
      controlsRef.current.material = transitionDebug.visualizePaintBuffer
        ? "paint-debug"
        : defaultMaterial;
      const brushPreviousCell: readonly [number, number] = state.hasRenderedBrushCell
        ? [state.previousRenderedBrushCellX, state.previousRenderedBrushCellY]
        : [state.brushCellX, state.brushCellY];
      const brushCanWrite =
        state.brushActive && frameTime - state.lastBrushMoveTime <= PAINT_MOVEMENT_GRACE_MS;
      renderer.render(
        context.getCurrentTexture().createView(),
        controlsRef.current,
        logicalWidth,
        logicalHeight,
        {
          progress: mixProgress,
          gridScaleMultiplier,
          glyphScale: clamp(transitionDebug.glyphScale, 0.5, 2.5),
          time: timeSeconds,
          mouse: [state.asciiMouseX, state.asciiMouseY],
          devicePixelRatio,
          paint: {
            // rAF timestamps are ms; deltaSeconds is converted once above and all paint
            // decay/diffusion/brush math expects seconds. Brush cells are raw pointer cells
            // (no lerp); the shader stamps the segment from previous rendered cell to current.
            dt: deltaSeconds,
            brushCell: [state.brushCellX, state.brushCellY],
            brushPreviousCell,
            brushRadius: clamp(transitionDebug.brushRadius, 1, 8),
            brushStrength: clamp(transitionDebug.brushStrength, 4, 32),
            brushActive: brushCanWrite,
            decayRate: clamp(transitionDebug.paintDecayPerFrame120, 0.002, 0.08) * 120,
            diffusionRate: clamp(transitionDebug.diffusionAmount, 0, 24),
            diffusionJitter: clamp(transitionDebug.diffusionJitter, 0, 4),
          },
        },
      );

      if (state.hasBrushCell) {
        state.previousRenderedBrushCellX = state.brushCellX;
        state.previousRenderedBrushCellY = state.brushCellY;
        state.hasRenderedBrushCell = true;
      }

      canvas.dataset.eveRenderMode = mixProgress >= 0.5 ? "agents" : "humans";
      canvas.dataset.eveAsciiProgress = mixProgress.toFixed(3);
      canvas.dataset.eveAsciiMode = mixProgress > 0.001 ? "active" : "inactive";
    } catch {
      state.cancelled = true;
      onFallback();
      onFatalError();
      return;
    }

    successfulRenderCount += 1;
    if (successfulRenderCount === CANVAS_REVEAL_RENDER_COUNT) {
      canvas.style.opacity = "1";
      finishCanvasFade = onCanvasFullyOpaque(canvas, onCanvasRevealed);
    }

    if (frameLoopProbe) {
      frameLoopProbe.frames += 1;
      frameLoopProbe.lastFrameAt = frameTime;
      updateFrameLoopProbeDataset();
    }
  };

  const start = () => {
    if (running) return;
    running = true;
    if (frameLoopProbe) {
      frameLoopProbe.running = true;
      updateFrameLoopProbeDataset(true);
    }
    const frameTime = performance.now();
    state.previousFrameTime = frameTime;
    if (evePointerInteractionMode(state.isCoarsePointer).autoRotateEnvYaw) {
      state.autoRotateStartTime = frameTime;
    }
  };

  const stop = () => {
    running = false;
    state.animationFrame = 0;
    if (frameLoopProbe) {
      frameLoopProbe.running = false;
      updateFrameLoopProbeDataset(true);
    }
  };

  return {
    start,
    stop,
    step: draw,
    dispose() {
      stop();
      finishCanvasFade?.();
    },
  };
}

function stepLogoModeProgress(
  current: number,
  target: number,
  deltaSeconds: number,
  durationSeconds: number,
) {
  const safeTarget = target >= 0.5 ? 1 : 0;
  const safeDuration = clamp(durationSeconds, 0.05, 2);
  const step = Math.max(0, deltaSeconds) / safeDuration;
  if (Math.abs(safeTarget - current) <= step) return safeTarget;
  return current + Math.sign(safeTarget - current) * step;
}

function onCanvasFullyOpaque(canvas: HTMLCanvasElement, callback: () => void) {
  let done = false;
  let timeout = 0;
  const finish = () => {
    if (done) return;
    done = true;
    canvas.removeEventListener("transitionend", onTransitionEnd);
    window.clearTimeout(timeout);
    if (canvas.isConnected) callback();
  };
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.propertyName === "opacity") finish();
  };

  canvas.addEventListener("transitionend", onTransitionEnd);
  timeout = window.setTimeout(finish, CANVAS_FADE_FALLBACK_MS);
  return finish;
}
