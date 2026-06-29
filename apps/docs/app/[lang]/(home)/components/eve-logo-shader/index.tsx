"use client";

import { App, Device, type VGPUAdapter } from "@vgpu/core";
import { useEffect, useRef, useState } from "react";
import { decodeGltfMesh, meshAspect } from "./mesh";
import { BLOOM_RADIUS, createEve5Renderer, type RenderControls } from "./render";

class BrowserAdapter implements VGPUAdapter {
  async requestDevice(): Promise<Device> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("WebGPU adapter unavailable.");
    return new Device(await adapter.requestDevice(), null);
  }
}

const MODEL_URL = "/eve-5/eve-logo.gltf";
const DEFAULT_LOGO_ASPECT = 78 / 25;
const DEFAULT_CONTROLS: RenderControls = {
  yaw: 0,
  pitch: 0,
  radius: 1.9,
  fov: 35,
  insideRendering: true,
  outsideRendering: true,
  material: "glass",
  wireframe: false,
  showEnv: false,
};
const LOGO_RENDER_HEIGHT = 500;
const MAX_DEVICE_PIXEL_RATIO = 2;

export function EveLogoShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<RenderControls>({ ...DEFAULT_CONTROLS });
  const [logoAspect, setLogoAspect] = useState(DEFAULT_LOGO_ASPECT);

  useEffect(() => {
    let cancelled = false;
    let animationFrame = 0;

    async function start() {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("webgpu");
      if (!canvas || !context || !navigator.gpu) return;

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
      context.configure({ device: app.device.gpu, format, alphaMode: "opaque" });
      const renderer = createEve5Renderer(app.device, format, mesh);

      const draw = () => {
        if (cancelled) return;
        resizeCanvas(canvas);
        // The renderer pads the logical scene size by BLOOM_RADIUS on each side before allocating
        // its offscreen back/depth targets. The canvas itself is that padded physical render target,
        // so subtract the padding here. Passing CSS/logical logo dimensions would make the front
        // shader's @builtin(position) sample different pixels from the back-side targets on DPR > 1.
        const logicalWidth = Math.max(1, canvas.width - BLOOM_RADIUS * 2);
        const logicalHeight = Math.max(1, canvas.height - BLOOM_RADIUS * 2);
        renderer.render(context.getCurrentTexture().createView(), controlsRef.current, logicalWidth, logicalHeight);
        animationFrame = requestAnimationFrame(draw);
      };

      draw();

      return () => {
        renderer.dispose();
        app.device.destroy();
      };
    }

    let cleanup: (() => void) | undefined;
    start()
      .then((dispose) => {
        cleanup = dispose;
      })
      .catch(() => {
        // The landing page must degrade silently when WebGPU or the GPU process is unavailable.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      cleanup?.();
    };
  }, []);

  const logicalSize = getLogicalRenderSize(logoAspect);
  const paddedWidth = logicalSize.width + BLOOM_RADIUS * 2;
  const paddedHeight = logicalSize.height + BLOOM_RADIUS * 2;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-1/2 z-0 h-[6em] max-w-none -translate-x-1/2 translate-y-[calc(-50%-0.4em)]"
      style={{
        aspectRatio: `${paddedWidth} / ${paddedHeight}`,
      }}
    >
      <canvas ref={canvasRef} className="block size-full" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-black" />
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

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
