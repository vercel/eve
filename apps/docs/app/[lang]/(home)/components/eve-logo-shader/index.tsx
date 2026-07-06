"use client";

import { App, Device, type VGPUAdapter } from "@vgpu/core";
import { getImageProps } from "next/image";
import fallbackDarkImage from "../../../../../public/eve-5/fallback-dark-content.webp";
import fallbackLightImage from "../../../../../public/eve-5/fallback-light-content.webp";
import { useEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { decodeGltfMesh, meshAspect } from "./mesh";
import { BLOOM_RADIUS, DEFAULT_CAMERA_FOV, cameraRadiusForFov, createEve5Renderer, type RenderControls } from "./render";
import type { InstallAudience } from "../install-switcher";

class BrowserAdapter implements VGPUAdapter {
  async requestDevice(): Promise<Device> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable.");
    return new Device(await adapter.requestDevice(), null);
  }
}

const MODEL_URL = "/eve-5/eve-logo.gltf";
const FALLBACK_IMAGE_WIDTH = 1095;
const FALLBACK_IMAGE_HEIGHT = 348;
const FALLBACK_IMAGE_ASPECT_RATIO = `${FALLBACK_IMAGE_WIDTH} / ${FALLBACK_IMAGE_HEIGHT}`;
const FALLBACK_CONTAINER_ASPECT_RATIO = `${FALLBACK_IMAGE_WIDTH + BLOOM_RADIUS} / ${FALLBACK_IMAGE_HEIGHT + BLOOM_RADIUS}`;
const FALLBACK_IMAGE_SIZES = "(min-width: 768px) 1095px, calc(100vw - 16px)";
const DEFAULT_LOGO_ASPECT = 78 / 25;
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
const LOGO_RENDER_HEIGHT = 500;
const MAX_DEVICE_PIXEL_RATIO = 2;
const FALLBACK_IMAGE_PADDING = BLOOM_RADIUS / MAX_DEVICE_PIXEL_RATIO;
const MAX_ENV_YAW = 0.3;
const MAX_ENV_PITCH = 0.2;
const ENV_YAW_LERP_SPEED = 3;
const AGENTS_ENV_YAW_OFFSET = -Math.PI * 0.1;
export const AGENTS_ENV_YAW_LERP_SPEED = 3;
const LOGO_MODE_TRANSITION_DURATION_SECONDS = 0.45;
const IMPRINT_GLYPH_SCALE = 1.35;
const ASCII_MOUSE_LERP_SPEED = 6;

const CANVAS_FADE_FALLBACK_MS = 800;
const CANVAS_REVEAL_RENDER_COUNT = 3;

type EveTransitionDebugGui = {
  destroy(): void;
};

type EveTransitionDebugState = {
  overrideEnabled: boolean;
  progress: number;
  gridScaleMultiplier: number;
  glyphScale: number;
  durationSeconds: number;
};

declare global {
  interface Window {
    __eveLogoTransitionDebugGui?: EveTransitionDebugGui;
  }
}

function getCurrentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  if (root.classList.contains("dark") || root.dataset.theme === "dark") return "dark";
  if (root.classList.contains("light") || root.dataset.theme === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function useResolvedTheme() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const syncTheme = () => setTheme(getCurrentTheme());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const observer = new MutationObserver(syncTheme);

    syncTheme();
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    media.addEventListener("change", syncTheme);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", syncTheme);
    };
  }, []);

  return theme;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setPrefersReducedMotion(media.matches);

    syncPreference();
    media.addEventListener("change", syncPreference);

    return () => media.removeEventListener("change", syncPreference);
  }, []);

  return prefersReducedMotion;
}

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
    const agentsSelected = audience === "agents";
    targetAgentsEnvYawMixRef.current = agentsSelected ? 1 : 0;
    targetLogoModeProgressRef.current = agentsSelected ? 1 : 0;
  }, [audience]);

  useEffect(() => {
    let cancelled = false;
    let animationFrame = 0;
    let cleanup: (() => void) | undefined;
    let mouseEnvYaw = controlsRef.current.envYaw;
    let targetMouseEnvYaw = mouseEnvYaw;
    let mouseEnvPitch = controlsRef.current.envPitch;
    let targetMouseEnvPitch = mouseEnvPitch;
    let asciiMouseX = 0;
    let asciiMouseY = 0;
    let targetAsciiMouseX = 0;
    let targetAsciiMouseY = 0;
    let agentsEnvYawMix = targetAgentsEnvYawMixRef.current;
    let previousFrameTime = performance.now();

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

    const updateEnvRotation = (clientX: number, clientY: number) => {
      const viewportWidth = Math.max(1, window.innerWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || 1);
      const clampedX = Math.max(0, Math.min(viewportWidth, clientX));
      const clampedY = Math.max(0, Math.min(viewportHeight, clientY));
      const normalizedX = (clampedX / viewportWidth) * 2 - 1;
      const normalizedY = (clampedY / viewportHeight) * 2 - 1;
      targetMouseEnvYaw = normalizedX * MAX_ENV_YAW;
      targetMouseEnvPitch = normalizedY * MAX_ENV_PITCH;
      targetAsciiMouseX = normalizedX;
      targetAsciiMouseY = normalizedY;
    };
    const onPointerMove = (event: PointerEvent) => updateEnvRotation(event.clientX, event.clientY);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    async function start() {
      const renderTheme = theme;
      const canvas = canvasRef.current;
      const context = canvas?.getContext("webgpu");
      if (!canvas || !context || !navigator.gpu) {
        setShowLightFallback(true);
        return;
      }

      const mesh = await loadMesh();
      if (cancelled) return;
      setLogoAspect(meshAspect(mesh));
      await nextFrame();
      resizeCanvas(canvas);

      const app = await App.create({ adapter: new BrowserAdapter() });
      if (cancelled) {
        app.device.destroy();
        return;
      }

      const format = navigator.gpu.getPreferredCanvasFormat();
      const alphaMode = renderTheme === "light" ? "premultiplied" : "opaque";
      context.configure({ device: app.device.gpu, format, alphaMode });
      const renderer = createEve5Renderer(app.device, format, mesh, { theme: renderTheme });
      let modeTransitionProgress = targetLogoModeProgressRef.current;
      let disposed = false;
      let transitionDebugGui: EveTransitionDebugGui | undefined;
      const transitionDebug: EveTransitionDebugState = {
        overrideEnabled: false,
        progress: modeTransitionProgress,
        gridScaleMultiplier: 1.03,
        glyphScale: IMPRINT_GLYPH_SCALE,
        durationSeconds: LOGO_MODE_TRANSITION_DURATION_SECONDS,
      };
      previousFrameTime = performance.now();

      const destroyTransitionDebugGui = () => {
        if (!transitionDebugGui) return;
        if (window.__eveLogoTransitionDebugGui === transitionDebugGui) {
          delete window.__eveLogoTransitionDebugGui;
        }
        transitionDebugGui.destroy();
        transitionDebugGui = undefined;
      };
      const setupTransitionDebugGui = async () => {
        if (!new URLSearchParams(window.location.search).has("debug")) return;
        const { GUI } = await import("lil-gui");
        if (cancelled || disposed) return;
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
        transitionDebugGui = guiHandle;
        window.__eveLogoTransitionDebugGui = guiHandle;
        gui.add(transitionDebug, "overrideEnabled").name("Override imprint");
        gui.add(transitionDebug, "progress", 0, 1, 0.001).name("Imprint progress");
        const imprint = gui.addFolder("Imprint");
        imprint.add(transitionDebug, "gridScaleMultiplier", 0.5, 2, 0.01).name("Grid scale multiplier");
        imprint.add(transitionDebug, "glyphScale", 0.5, 2.5, 0.01).name("Glyph scale");
        imprint.open();
        gui.add(transitionDebug, "durationSeconds", 0.05, 2, 0.01).name("Transition duration (s)");
      };
      void setupTransitionDebugGui();

      let successfulRenderCount = 0;
      let finishCanvasFade: (() => void) | undefined;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        cancelAnimationFrame(animationFrame);
        finishCanvasFade?.();
        resetCanvasVisibility(canvas);
        if (!cancelled) setRevealed(false);
        destroyTransitionDebugGui();
        renderer.dispose();
        app.device.destroy();
      };

      app.device.gpu.lost
        .then(() => {
          if (cancelled) return;
          setRevealed(false);
          setShowLightFallback(true);
          cancelled = true;
          dispose();
        })
        .catch(() => {
          // The landing page must degrade silently when the GPU process is unavailable.
        });

      const draw = (frameTime = performance.now()) => {
        if (cancelled || disposed) return;

        const deltaSeconds = Math.max(0, (frameTime - previousFrameTime) / 1000);
        previousFrameTime = frameTime;
        mouseEnvYaw = safeLerp(mouseEnvYaw, targetMouseEnvYaw, deltaSeconds * ENV_YAW_LERP_SPEED);
        mouseEnvPitch = safeLerp(mouseEnvPitch, targetMouseEnvPitch, deltaSeconds * ENV_YAW_LERP_SPEED);
        asciiMouseX = safeLerp(asciiMouseX, targetAsciiMouseX, deltaSeconds * ASCII_MOUSE_LERP_SPEED);
        asciiMouseY = safeLerp(asciiMouseY, targetAsciiMouseY, deltaSeconds * ASCII_MOUSE_LERP_SPEED);
        const targetAgentsEnvYawMix = targetAgentsEnvYawMixRef.current;
        agentsEnvYawMix = safeLerp(agentsEnvYawMix, targetAgentsEnvYawMix, deltaSeconds * AGENTS_ENV_YAW_LERP_SPEED);
        controlsRef.current.envYaw = mouseEnvYaw + agentsEnvYawMix * AGENTS_ENV_YAW_OFFSET;
        controlsRef.current.envPitch = mouseEnvPitch;

        resizeCanvas(canvas);
        // The renderer pads the logical scene size by BLOOM_RADIUS on each side before allocating
        // its offscreen back/depth targets. The canvas itself is that padded physical render target,
        // so subtract the padding here. Passing CSS/logical logo dimensions would make the front
        // shader's @builtin(position) sample different pixels from the back-side targets on DPR > 1.
        const logicalWidth = Math.max(1, canvas.width - BLOOM_RADIUS * 2);
        const logicalHeight = Math.max(1, canvas.height - BLOOM_RADIUS * 2);

        try {
          const transitionDurationSeconds = clampRange(transitionDebug.durationSeconds, 0.05, 2);
          modeTransitionProgress = stepLogoModeProgress(
            modeTransitionProgress,
            targetLogoModeProgressRef.current,
            deltaSeconds,
            transitionDurationSeconds,
          );
          const animatedMixProgress = easeLogoModeProgress(modeTransitionProgress);
          const mixProgress = transitionDebug.overrideEnabled ? clampUnit(transitionDebug.progress) : animatedMixProgress;
          const timeSeconds = frameTime / 1000;
          renderer.render(context.getCurrentTexture().createView(), controlsRef.current, logicalWidth, logicalHeight, {
            progress: mixProgress,
            gridScaleMultiplier: clampRange(transitionDebug.gridScaleMultiplier, 0.5, 2),
            glyphScale: clampRange(transitionDebug.glyphScale, 0.5, 2.5),
            time: timeSeconds,
            mouse: [asciiMouseX, asciiMouseY],
          });

          canvas.dataset.eveRenderMode = mixProgress >= 0.5 ? "agents" : "humans";
          canvas.dataset.eveAsciiProgress = mixProgress.toFixed(3);
          canvas.dataset.eveAsciiMode = mixProgress > 0.001 ? "active" : "inactive";
        } catch {
          cancelled = true;
          setRevealed(false);
          setShowLightFallback(true);
          dispose();
          return;
        }

        successfulRenderCount += 1;
        if (successfulRenderCount === CANVAS_REVEAL_RENDER_COUNT) {
          canvas.style.opacity = "1";
          finishCanvasFade = onCanvasFullyOpaque(canvas, () => {
            if (!cancelled) setRevealed(true);
          });
        }

        animationFrame = requestAnimationFrame(draw);
      };

      draw();

      return dispose;
    }

    start()
      .then((dispose) => {
        cleanup = dispose;
      })
      .catch(() => {
        setShowLightFallback(true);
        // The landing page must degrade silently when WebGPU or the GPU process is unavailable.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("pointermove", onPointerMove);
      cleanup?.();
      resetCanvasVisibility(canvasRef.current);
    };
  }, [theme, prefersReducedMotion]);

  const logicalSize = getLogicalRenderSize(logoAspect);
  const paddedWidth = logicalSize.width + BLOOM_RADIUS * 2;
  const paddedHeight = logicalSize.height + BLOOM_RADIUS * 2;
  const fallbackImageOptions = {
    alt: "",
    width: FALLBACK_IMAGE_WIDTH,
    height: FALLBACK_IMAGE_HEIGHT,
    sizes: FALLBACK_IMAGE_SIZES,
    priority: true,
    quality: 95,
  } as const;
  const { props: fallbackLightImageProps } = getImageProps({
    ...fallbackImageOptions,
    src: fallbackLightImage,
  });
  const { props: fallbackDarkImageProps } = getImageProps({
    ...fallbackImageOptions,
    src: fallbackDarkImage,
  });

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

function FallbackImage({
  imageProps,
  visible,
  className,
}: {
  imageProps: ComponentProps<"img">;
  visible: boolean;
  className: string;
}) {
  return (
    <div
      className={`${className} absolute transition-opacity duration-700 ease-linear ${visible ? "opacity-100" : "opacity-0"}`}
      style={{ inset: FALLBACK_IMAGE_PADDING }}
    >
      <img
        {...imageProps}
        aria-hidden="true"
        role="presentation"
        decoding="async"
        className="absolute left-1/2 top-1/2 h-full w-auto max-w-none -translate-x-1/2 -translate-y-1/2"
        style={{ aspectRatio: FALLBACK_IMAGE_ASPECT_RATIO }}
      />
    </div>
  );
}

async function loadMesh() {
  const response = await fetch(MODEL_URL, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${MODEL_URL}: ${response.status}`);
  return decodeGltfMesh(await response.json(), (uri) => loadGltfBuffer(uri, MODEL_URL));
}

async function loadGltfBuffer(uri: string, modelUrl: string) {
  if (uri.startsWith("data:application/octet-stream;base64,")) {
    return Uint8Array.from(atob(uri.split(",")[1]!), (char) => char.charCodeAt(0)).buffer;
  }
  const url = new URL(uri, window.location.origin + modelUrl);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load glTF buffer ${url.pathname}: ${response.status}`);
  return response.arrayBuffer();
}

function getLogicalRenderSize(aspect: number) {
  return {
    width: Math.max(1, Math.round(LOGO_RENDER_HEIGHT * aspect)),
    height: LOGO_RENDER_HEIGHT,
  };
}

function resizeCanvas(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function safeLerp(from: number, to: number, amount: number) {
  const safeAmount = Math.max(0, Math.min(1, amount));
  return from + (to - from) * safeAmount;
}

function clampUnit(value: number) {
  return clampRange(value, 0, 1);
}

function clampRange(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function stepLogoModeProgress(current: number, target: number, deltaSeconds: number, durationSeconds: number) {
  const safeTarget = target >= 0.5 ? 1 : 0;
  const safeDuration = clampRange(durationSeconds, 0.05, 2);
  const step = Math.max(0, deltaSeconds) / safeDuration;
  if (Math.abs(safeTarget - current) <= step) return safeTarget;
  return current + Math.sign(safeTarget - current) * step;
}

function easeLogoModeProgress(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

function resetCanvasVisibility(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.style.opacity = "";
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

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
