"use client";

import { App, Device, type VGPUAdapter } from "@vgpu/core";
import { createDevicePixelRatio, prefersReducedMotion as prefersReducedMotionSync } from "phase";
import {
  useLoop,
  useMediaQuery,
  usePrefersReducedMotion,
  useSize,
  useStableCallback,
  useSyncedRef,
} from "phase/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { preload } from "react-dom";
import { meshAspect } from "./mesh";
import {
  FallbackImage,
  FALLBACK_CONTAINER_ASPECT_RATIO,
  getFallbackImageProps,
} from "./fallback-image";
import { useResolvedTheme } from "./hooks";
import {
  DEFAULT_LOGO_ASPECT,
  getLogicalRenderSize,
  resizeCanvas,
  type CanvasLayout,
} from "./runtime/canvas-sizing";
import { loadMesh, MODEL_URL } from "./runtime/load-mesh";
import {
  destroyTransitionDebugGui,
  setupTransitionDebugGui,
  type EveTransitionDebugGui,
  type EveTransitionDebugState,
} from "./runtime/debug-gui";
import { createDrawLoop, type DrawLoop } from "./runtime/frame-loop";
import { createPointerController, syncPointerInteractionMode } from "./runtime/pointer-input";
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
const IMPRINT_GLYPH_SCALE = 1.27;
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const INITIAL_CANVAS_LAYOUT: CanvasLayout = { width: 1, height: 1 };

export function EveLogoShader({ audience = "humans" }: { audience?: InstallAudience }) {
  preload(MODEL_URL, { as: "fetch", crossOrigin: "anonymous" });
  const prefersDarkTheme = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useResolvedTheme(prefersDarkTheme);
  const prefersReducedMotion = usePrefersReducedMotion();
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const containerRef = useRef<HTMLDivElement>(null);
  const { size: containerSize } = useSize({ ref: containerRef });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<RenderControls>({ ...DEFAULT_CONTROLS });
  const canvasLayoutRef = useRef<CanvasLayout>(INITIAL_CANVAS_LAYOUT);
  const devicePixelRatioRef = useRef(1);
  const coarsePointerRef = useSyncedRef(coarsePointer);
  const stateRef = useRef<HeroRuntimeState | null>(null);
  const drawLoopRef = useRef<DrawLoop | null>(null);
  const loopPhaseRef = useRef("idle");
  const invalidatePointerCanvasRectRef = useRef(() => {});
  const [logoAspect, setLogoAspect] = useState(DEFAULT_LOGO_ASPECT);
  const [revealed, setRevealed] = useState(false);
  const [showLightFallback, setShowLightFallback] = useState(false);
  const targetAgentsEnvYawMixRef = useRef(audience === "agents" ? 1 : 0);
  const targetLogoModeProgressRef = useRef(audience === "agents" ? 1 : 0);
  const agentsSelected = audience === "agents";
  targetAgentsEnvYawMixRef.current = agentsSelected ? 1 : 0;
  targetLogoModeProgressRef.current = agentsSelected ? 1 : 0;
  const handleCanvasRevealed = useStableCallback(() => {
    if (!stateRef.current?.cancelled) setRevealed(true);
  });
  const handleFallback = useStableCallback(() => {
    setRevealed(false);
    setShowLightFallback(true);
  });
  const fatalErrorRef = useRef<(() => void) | null>(null);
  const handleFatalError = useStableCallback(() => {
    fatalErrorRef.current?.();
  });

  const { phase: loopPhase } = useLoop({
    ref: containerRef,
    reducedMotion: "pause",
    intersectionOptions: { threshold: 0 },
    onTick: (frame) => {
      drawLoopRef.current?.step(frame.time);
    },
  });

  useEffect(() => {
    loopPhaseRef.current = loopPhase;
    const canvas = canvasRef.current;
    if (!IS_PRODUCTION && canvas) {
      canvas.dataset.heroPhase = loopPhase === "running" ? "active" : String(loopPhase);
    }
    if (loopPhase === "running") drawLoopRef.current?.start();
    else drawLoopRef.current?.stop();
  }, [loopPhase]);

  useEffect(() => {
    if (!containerSize) return;
    canvasLayoutRef.current = containerSize;
    invalidatePointerCanvasRectRef.current();
  }, [containerSize]);

  useEffect(() => {
    const state = stateRef.current;
    if (state) syncPointerInteractionMode(state, coarsePointer);
  }, [coarsePointer]);

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
      isCoarsePointer: coarsePointerRef.current,
    };
    stateRef.current = state;

    const canvas = canvasRef.current;
    resetCanvasVisibility(canvas);
    setRevealed(false);

    const dprWatcher = createDevicePixelRatio({
      onChange: (dpr) => {
        devicePixelRatioRef.current = dpr;
        invalidatePointerCanvasRectRef.current();
      },
    });
    devicePixelRatioRef.current = dprWatcher.dpr;

    const pointerController = createPointerController({
      state,
      controlsRef,
      canvasRef,
      coarsePointerRef,
      canvasLayoutRef,
      devicePixelRatioRef,
    });
    invalidatePointerCanvasRectRef.current = pointerController.invalidateCanvasRect;

    const cleanupSetup = () => {
      state.cancelled = true;
      pointerController.detach();
      dprWatcher.stop();
      invalidatePointerCanvasRectRef.current = () => {};
      state.cleanup = undefined;
      stateRef.current = null;
      drawLoopRef.current = null;
      fatalErrorRef.current = null;
      resetCanvasVisibility(canvasRef.current);
    };

    const resolvedPrefersReducedMotion = prefersReducedMotion || prefersReducedMotionSync();
    if (resolvedPrefersReducedMotion) {
      // No WebGPU animation will run (reduced motion or the preference hasn't
      // resolved yet), so the canvas stays hidden. Show the static light
      // fallback to mirror the dark fallback, which is always visible until
      // the animation reveals. Otherwise light-theme users would see a blank hero.
      setShowLightFallback(true);
      return cleanupSetup;
    }
    setShowLightFallback(false);

    let disposeRuntime: (() => void) | undefined;

    async function start() {
      const renderTheme = theme;
      const canvas = canvasRef.current;
      const container = containerRef.current;
      const context = canvas?.getContext("webgpu");
      if (!canvas || !container || !context || !navigator.gpu) {
        setShowLightFallback(true);
        return;
      }

      const mesh = await loadMesh();
      if (state.cancelled) return;
      state.activeMesh = mesh;
      setLogoAspect(meshAspect(mesh));
      await nextFrame();
      resizeCanvas(canvas, canvasLayoutRef, devicePixelRatioRef);

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
        gridScaleMultiplier: 1.31,
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
        drawLoopRef.current = null;
        fatalErrorRef.current = null;
        drawLoopDispose?.();
        resetCanvasVisibility(canvas);
        if (!state.cancelled) setRevealed(false);
        destroyTransitionDebugGui(transitionDebugGui);
        transitionDebugGui = undefined;
        renderer.dispose();
        app.device.destroy();
        disposeRuntime = undefined;
      };
      disposeRuntime = dispose;

      app.device.gpu.lost
        .then((info) => {
          if (state.cancelled || disposed || info?.reason === "destroyed") return;
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
        canvasLayoutRef,
        devicePixelRatioRef,
        onCanvasRevealed: handleCanvasRevealed,
        onFallback: handleFallback,
        onFatalError: handleFatalError,
      });
      drawLoopDispose = drawLoop.dispose;
      drawLoopRef.current = drawLoop;
      fatalErrorRef.current = dispose;
      if (loopPhaseRef.current === "running") drawLoop.start();

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
      cleanupSetup();
      disposeRuntime?.();
    };
  }, [theme, prefersReducedMotion, handleCanvasRevealed, handleFallback, handleFatalError]);

  const logicalSize = getLogicalRenderSize(logoAspect);
  const paddedWidth = logicalSize.width + BLOOM_RADIUS * 2;
  const paddedHeight = logicalSize.height + BLOOM_RADIUS * 2;
  const { fallbackLightImageProps, fallbackDarkImageProps } = getFallbackImageProps();

  return (
    <div
      ref={containerRef}
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
