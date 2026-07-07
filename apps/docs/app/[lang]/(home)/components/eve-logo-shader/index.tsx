"use client";

import { App, Device, type VGPUAdapter } from "@vgpu/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { meshAspect } from "./mesh";
import {
  FallbackImage,
  FALLBACK_CONTAINER_ASPECT_RATIO,
  getFallbackImageProps,
} from "./fallback-image";
import { usePrefersReducedMotion, useResolvedTheme } from "./hooks";
import { DEFAULT_LOGO_ASPECT, getLogicalRenderSize, resizeCanvas } from "./runtime/canvas-sizing";
import { loadMesh } from "./runtime/load-mesh";
import {
  destroyTransitionDebugGui,
  setupTransitionDebugGui,
  type EveTransitionDebugGui,
  type EveTransitionDebugState,
} from "./runtime/debug-gui";
import { createDrawLoop } from "./runtime/frame-loop";
import { createPointerController } from "./runtime/pointer-input";
import type { HeroRuntimeState } from "./runtime/state";
import {
  BLOOM_RADIUS,
  DEFAULT_CAMERA_FOV,
  DEFAULT_PAINT_BRUSH_RADIUS,
  DEFAULT_PAINT_BRUSH_STRENGTH,
  DEFAULT_PAINT_DECAY_PER_FRAME_120,
  DEFAULT_PAINT_DIFFUSION_JITTER,
  DEFAULT_PAINT_DIFFUSION_RATE,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  cameraRadiusForFov,
  createEve5Renderer,
  type RenderControls,
} from "./render";
import type { InstallAudience } from "../install-switcher";

class BrowserAdapter implements VGPUAdapter {
  async requestDevice(): Promise<Device> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable.");
    return new Device(await adapter.requestDevice(), null);
  }
}

const DEFAULT_CONTROLS: RenderControls = {
  yaw: 0,
  pitch: 0,
  radius: cameraRadiusForFov(DEFAULT_CAMERA_FOV),
  fov: DEFAULT_CAMERA_FOV,
  envYaw: 0,
  envPitch: 0,
  insideRendering: true,
  outsideRendering: true,
  material: "glass",
  wireframe: false,
  showEnv: false,
};
export const AGENTS_ENV_YAW_LERP_SPEED = 3;
const LOGO_MODE_TRANSITION_DURATION_SECONDS = 0.45;
const IMPRINT_GLYPH_SCALE = 1.35;
export function EveLogoShader({ audience = "humans" }: { audience?: InstallAudience }) {
  const theme = useResolvedTheme();
  const prefersReducedMotion = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<RenderControls>({ ...DEFAULT_CONTROLS });
  const [logoAspect, setLogoAspect] = useState(DEFAULT_LOGO_ASPECT);
  const [revealed, setRevealed] = useState(false);
  const [showLightFallback, setShowLightFallback] = useState(false);
  const targetAgentsEnvYawMixRef = useRef(audience === "agents" ? 1 : 0);
  const targetLogoModeProgressRef = useRef(audience === "agents" ? 1 : 0);
  const agentsSelected = audience === "agents";
  targetAgentsEnvYawMixRef.current = agentsSelected ? 1 : 0;
  targetLogoModeProgressRef.current = agentsSelected ? 1 : 0;

  useEffect(() => {
    const state: HeroRuntimeState = {
      cancelled: false,
      animationFrame: 0,
      cleanup: undefined,
      mouseEnvYaw: controlsRef.current.envYaw,
      targetMouseEnvYaw: controlsRef.current.envYaw,
      mouseEnvPitch: controlsRef.current.envPitch,
      targetMouseEnvPitch: controlsRef.current.envPitch,
      asciiMouseX: 0,
      asciiMouseY: 0,
      targetAsciiMouseX: 0,
      targetAsciiMouseY: 0,
      brushCellX: 0,
      brushCellY: 0,
      previousRenderedBrushCellX: 0,
      previousRenderedBrushCellY: 0,
      hasBrushCell: false,
      hasRenderedBrushCell: false,
      brushActive: false,
      paintGridScaleMultiplier: DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
      targetBrushActive: false,
      activeMesh: undefined,
      agentsEnvYawMix: targetAgentsEnvYawMixRef.current,
      previousFrameTime: performance.now(),
      autoRotateStartTime: performance.now(),
      lastBrushMoveTime: Number.NEGATIVE_INFINITY,
      lastPointerClientX: undefined,
      lastPointerClientY: undefined,
      isCoarsePointer: window.matchMedia("(pointer: coarse)").matches,
    };

    const canvas = canvasRef.current;
    resetCanvasVisibility(canvas);
    setRevealed(false);

    if (prefersReducedMotion !== false) {
      // No WebGPU animation will run (reduced motion or the preference hasn't
      // resolved yet), so the canvas stays hidden. Show the static light
      // fallback to mirror the dark fallback, which is always visible until
      // the animation reveals. Otherwise light-theme users would see a blank hero.
      setShowLightFallback(true);
      return;
    }
    setShowLightFallback(false);

    const pointerController = createPointerController({ state, controlsRef, canvasRef });

    async function start() {
      const renderTheme = theme;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("webgpu");
      if (!canvas || !context || !navigator.gpu) {
        setShowLightFallback(true);
        return;
      }

      const mesh = await loadMesh();
      if (state.cancelled) return;
      state.activeMesh = mesh;
      setLogoAspect(meshAspect(mesh));
      await nextFrame();
      resizeCanvas(canvas);

      const app = await App.create({ adapter: new BrowserAdapter() });
      if (state.cancelled) {
        app.device.destroy();
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      const alphaMode = renderTheme === "light" ? "premultiplied" : "opaque";
      context.configure({ device: app.device.gpu, format, alphaMode });
      const renderer = createEve5Renderer(app.device, format, mesh, { theme: renderTheme });
      let disposed = false;
      let drawLoopDispose: (() => void) | undefined;
      let transitionDebugGui: EveTransitionDebugGui | undefined;
      const modeTransitionProgressRef = { current: targetLogoModeProgressRef.current };
      const transitionDebug: EveTransitionDebugState = {
        overrideEnabled: false,
        progress: modeTransitionProgressRef.current,
        gridScaleMultiplier: DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
        glyphScale: IMPRINT_GLYPH_SCALE,
        durationSeconds: LOGO_MODE_TRANSITION_DURATION_SECONDS,
        paintDecayPerFrame120: DEFAULT_PAINT_DECAY_PER_FRAME_120,
        diffusionAmount: DEFAULT_PAINT_DIFFUSION_RATE,
        diffusionJitter: DEFAULT_PAINT_DIFFUSION_JITTER,
        brushRadius: DEFAULT_PAINT_BRUSH_RADIUS,
        brushStrength: DEFAULT_PAINT_BRUSH_STRENGTH,
        visualizePaintBuffer: false,
      };
      state.previousFrameTime = performance.now();
      state.autoRotateStartTime = state.previousFrameTime;

      void setupTransitionDebugGui({
        transitionDebug,
        isCancelled: () => state.cancelled,
        isDisposed: () => disposed,
        onReady: (gui) => {
          transitionDebugGui = gui;
        },
      });

      const dispose = () => {
        if (disposed) return;
        disposed = true;
        drawLoopDispose?.();
        resetCanvasVisibility(canvas);
        if (!state.cancelled) setRevealed(false);
        destroyTransitionDebugGui(transitionDebugGui);
        transitionDebugGui = undefined;
        renderer.dispose();
        app.device.destroy();
      };

      app.device.gpu.lost
        .then(() => {
          if (state.cancelled) return;
          setRevealed(false);
          setShowLightFallback(true);
          state.cancelled = true;
          dispose();
        })
        .catch(() => {
          // The landing page must degrade silently when the GPU process is unavailable.
        });

      const drawLoop = createDrawLoop({
        state,
        canvas,
        context,
        renderer,
        controlsRef,
        transitionDebug,
        modeTransitionProgressRef,
        targetLogoModeProgressRef,
        targetAgentsEnvYawMixRef,
        defaultMaterial: DEFAULT_CONTROLS.material,
        onCanvasRevealed: () => {
          if (!state.cancelled) setRevealed(true);
        },
        onFallback: () => {
          setRevealed(false);
          setShowLightFallback(true);
        },
        onFatalError: dispose,
      });
      drawLoopDispose = drawLoop.dispose;
      drawLoop.draw();

      return dispose;
    }

    start()
      .then((dispose) => {
        state.cleanup = dispose;
      })
      .catch(() => {
        setShowLightFallback(true);
        // The landing page must degrade silently when WebGPU or the GPU process is unavailable.
      });

    return () => {
      state.cancelled = true;
      cancelAnimationFrame(state.animationFrame);
      pointerController.detach();
      state.cleanup?.();
      resetCanvasVisibility(canvasRef.current);
    };
  }, [theme, prefersReducedMotion]);

  const logicalSize = getLogicalRenderSize(logoAspect);
  const paddedWidth = logicalSize.width + BLOOM_RADIUS * 2;
  const paddedHeight = logicalSize.height + BLOOM_RADIUS * 2;
  const { fallbackLightImageProps, fallbackDarkImageProps } = getFallbackImageProps();

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative z-0 mb-8 aspect-[var(--eve-logo-mobile-aspect-ratio)] w-full md:absolute md:left-1/2 md:top-1/2 md:mb-0 md:h-[6.5em] md:w-auto md:max-w-none md:-translate-x-1/2 md:translate-y-[calc(-50%-0.42em)] md:aspect-[var(--eve-logo-desktop-aspect-ratio)]"
      style={
        {
          "--eve-logo-mobile-aspect-ratio": FALLBACK_CONTAINER_ASPECT_RATIO,
          "--eve-logo-desktop-aspect-ratio": `${paddedWidth} / ${paddedHeight}`,
        } as CSSProperties
      }
    >
      <FallbackImage
        imageProps={fallbackLightImageProps}
        visible={showLightFallback && !revealed}
        className="dark:hidden"
      />
      <FallbackImage
        imageProps={fallbackDarkImageProps}
        visible={!revealed}
        className="hidden dark:block"
      />
      <canvas
        ref={canvasRef}
        data-eve-audience={audience}
        data-eve-target-ascii={audience === "agents" ? "true" : "false"}
        className="absolute inset-0 size-full opacity-0 transition-opacity duration-700 ease-linear"
      />
      <div className="pointer-events-none absolute inset-0 hidden bg-gradient-to-b from-transparent from-20% to-background-200/80 md:block dark:from-40% dark:to-black" />
    </div>
  );
}

function resetCanvasVisibility(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.style.opacity = "";
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
