"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const EVE_MARK_PATH =
  "M600.491 30.1025H417.913L290.411 188.43H250L282.329 148.17L401.541 0H600.491V30.1025ZM162.992 188.351H0V158.248H162.992V188.351ZM600.491 158.248V188.351H437.5V158.248H600.491ZM137.363 108.609H0V78.5068H137.363V108.609ZM600.491 108.609H463.129V78.5068H600.491V108.609ZM250.001 30.1025H0V0H250.001V30.1025Z";
const EVE_MARK_WIDTH = 601;
const EVE_MARK_HEIGHT = 189;

interface MetalConfig {
  roughness: number;
  specular: number;
  fresnel: number;
  flowSpeed: number;
  distortion: number;
  tint: number;
  brushAngle: number;
  tonemap: number;
}

const DEFAULT_CONFIG: MetalConfig = {
  roughness: 0.1,
  specular: 1.5,
  fresnel: 0.8,
  flowSpeed: 0.6,
  distortion: 0.5,
  tint: 0.15,
  brushAngle: 0,
  tonemap: 0.6,
};

const HERO_CONFIG: MetalConfig = {
  roughness: 0.12,
  specular: 1.35,
  fresnel: 0.78,
  flowSpeed: 0.38,
  distortion: 0.42,
  tint: 0.18,
  brushAngle: 0.32,
  tonemap: 0.72,
};
const HERO_MARK_SCALE = 0.97;

type MetalShaderProps = {
  className?: string;
  config?: MetalConfig;
  svgScale?: number;
  svgPath?: string;
  svgWidth?: number;
  svgHeight?: number;
};

function getLogoTransform(
  width: number,
  height: number,
  svgScale: number,
  svgWidth: number,
  svgHeight: number,
) {
  const scale = Math.min(width / svgWidth, height / svgHeight) * svgScale;
  return {
    scale,
    offsetX: (width - svgWidth * scale) / 2,
    offsetY: (height - svgHeight * scale) / 2,
  };
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

export function MetalShader({
  className,
  config = DEFAULT_CONFIG,
  svgScale = 0.92,
  svgPath = EVE_MARK_PATH,
  svgWidth = EVE_MARK_WIDTH,
  svgHeight = EVE_MARK_HEIGHT,
}: MetalShaderProps) {
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const configRef = useRef(config);
  const svgScaleRef = useRef(svgScale);
  const mouseRef = useRef({ x: 0, y: 0 });
  const shadeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const envDataRef = useRef<Uint8ClampedArray | null>(null);
  const maskPixelsRef = useRef<Uint8ClampedArray | null>(null);
  const blurPixelsRef = useRef<Uint8ClampedArray | null>(null);
  const sizeRef = useRef({ w: 0, h: 0, dpr: 1, renderScale: 1 });
  const needsRebuildRef = useRef(true);
  const themeRef = useRef(theme);
  const svgPathRef = useRef(svgPath);
  const svgWidthRef = useRef(svgWidth);
  const svgHeightRef = useRef(svgHeight);
  const startTimeRef = useRef<number | null>(null);
  const glowColorRef = useRef("currentColor");

  configRef.current = config;
  svgScaleRef.current = svgScale;
  themeRef.current = theme;
  svgPathRef.current = svgPath;
  svgWidthRef.current = svgWidth;
  svgHeightRef.current = svgHeight;

  const buildEnvMap = useCallback(() => {
    const size = 1024;
    const data = new Uint8ClampedArray(size * 4);
    for (let i = 0; i < size; i++) {
      const t = i / size;
      let v = 25;
      v += 230 * Math.exp(-((t - 0.48) * (t - 0.48)) / 0.003);
      v += 140 * Math.exp(-((t - 0.2) * (t - 0.2)) / 0.004);
      v += 160 * Math.exp(-((t - 0.72) * (t - 0.72)) / 0.005);
      v += 40 * Math.exp(-((t - 0.35) * (t - 0.35)) / 0.02);
      v += 35 * Math.exp(-((t - 0.6) * (t - 0.6)) / 0.015);
      v += 60 * Math.exp(-((t - 0.05) * (t - 0.05)) / 0.003);
      v += 55 * Math.exp(-((t - 0.9) * (t - 0.9)) / 0.004);
      const c = Math.min(255, v | 0);
      const idx = i * 4;
      data[idx] = c;
      data[idx + 1] = c;
      data[idx + 2] = c;
      data[idx + 3] = 255;
    }
    envDataRef.current = data;
  }, []);

  const buildMask = useCallback(() => {
    const { w, h, renderScale } = sizeRef.current;
    const sw = Math.round(w * renderScale);
    const sh = Math.round(h * renderScale);
    if (w === 0 || h === 0) return;

    if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement("canvas");
    const maskCanvas = maskCanvasRef.current;
    maskCanvas.width = sw;
    maskCanvas.height = sh;

    const { scale, offsetX, offsetY } = getLogoTransform(
      w,
      h,
      svgScaleRef.current,
      svgWidthRef.current,
      svgHeightRef.current,
    );
    const path = new Path2D(svgPathRef.current);
    const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!maskContext) return;

    maskContext.fillStyle = "#000";
    maskContext.fillRect(0, 0, sw, sh);
    maskContext.save();
    maskContext.translate(offsetX * renderScale, offsetY * renderScale);
    maskContext.scale(scale * renderScale, scale * renderScale);
    maskContext.fillStyle = "#fff";
    maskContext.fill(path);
    maskContext.restore();
    maskPixelsRef.current = maskContext.getImageData(0, 0, sw, sh).data;

    const blurCanvas = document.createElement("canvas");
    blurCanvas.width = sw;
    blurCanvas.height = sh;
    const blurContext = blurCanvas.getContext("2d", { willReadFrequently: true });
    if (!blurContext) return;

    blurContext.filter = `blur(${Math.round(5 * renderScale)}px)`;
    blurContext.drawImage(maskCanvas, 0, 0);
    blurPixelsRef.current = blurContext.getImageData(0, 0, sw, sh).data;
    needsRebuildRef.current = false;
  }, []);

  const init = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const renderScale = Math.min(dpr, 1.35);

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    sizeRef.current = { w, h, dpr, renderScale };
    mouseRef.current = { x: w * 0.58, y: h * 0.35 };
    needsRebuildRef.current = true;
    startTimeRef.current = null;
    glowColorRef.current = getComputedStyle(canvas).color;

    const sw = Math.round(w * renderScale);
    const sh = Math.round(h * renderScale);
    if (!shadeCanvasRef.current) shadeCanvasRef.current = document.createElement("canvas");
    shadeCanvasRef.current.width = sw;
    shadeCanvasRef.current.height = sh;

    if (!envDataRef.current) buildEnvMap();
  }, [buildEnvMap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    init();
    const observer = new ResizeObserver(init);
    observer.observe(canvas);
    window.addEventListener("resize", init);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", init);
    };
  }, [init]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onPointerMove = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    canvas.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => canvas.removeEventListener("pointermove", onPointerMove);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let outImg: ImageData | null = null;
    let lastSw = 0;
    let lastSh = 0;
    const tonemapLUT = new Uint8Array(256);
    let lastTonemap = -1;
    let glowPath: Path2D | null = null;
    let lastGlowSvg = "";
    let lastBrushAngle = -999;
    let brushCos = 1;
    let brushSin = 0;

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp;
      const introElapsed = (timestamp - startTimeRef.current) * 0.001;
      const introDuration = 1.0;

      if (needsRebuildRef.current) buildMask();

      const cfg = configRef.current;
      const { w, h, dpr, renderScale } = sizeRef.current;
      const time = timestamp * 0.001;
      const mouse = mouseRef.current;
      const envData = envDataRef.current;
      const mask = maskPixelsRef.current;
      const blur = blurPixelsRef.current;
      const shadeCanvas = shadeCanvasRef.current;

      if (!envData || !mask || !blur || !shadeCanvas || w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      const sw = Math.round(w * renderScale);
      const sh = Math.round(h * renderScale);
      const shadeContext = shadeCanvas.getContext("2d", { willReadFrequently: true });
      if (!shadeContext) {
        rafRef.current = requestAnimationFrame(animate);
        return;
      }

      if (!outImg || sw !== lastSw || sh !== lastSh) {
        outImg = shadeContext.createImageData(sw, sh);
        lastSw = sw;
        lastSh = sh;
      }

      const out = outImg.data;
      out.fill(0);

      const stride = sw * 4;
      const envLen = 1024;
      if (cfg.tonemap !== lastTonemap) {
        lastTonemap = cfg.tonemap;
        if (cfg.tonemap === 1) {
          for (let i = 0; i < 256; i++) tonemapLUT[i] = i;
        } else {
          const invTone = 1 / cfg.tonemap;
          for (let i = 0; i < 256; i++) {
            tonemapLUT[i] = (255 * Math.pow(i / 255, invTone)) | 0;
          }
        }
      }

      if (cfg.brushAngle !== lastBrushAngle) {
        lastBrushAngle = cfg.brushAngle;
        brushCos = Math.cos(cfg.brushAngle);
        brushSin = Math.sin(cfg.brushAngle);
      }

      const mx = mouse.x / w;
      const my = mouse.y / h;
      const t13 = time * cfg.flowSpeed * 1.3;
      const t09 = time * cfg.flowSpeed * 0.9;
      const t05 = time * cfg.flowSpeed * 0.5;
      const t18 = time * cfg.flowSpeed * 1.8;
      const tEnv = time * cfg.flowSpeed * 0.03;
      const invSw = 1 / sw;
      const invSh = 1 / sh;
      const isLight = themeRef.current === "light";

      for (let y = 1; y < sh - 1; y++) {
        const yOff = y * stride;
        const py = y * invSh;

        for (let x = 1; x < sw - 1; x++) {
          const idx = yOff + x * 4;
          if (mask[idx] < 128) continue;

          const left = blur[idx - 4];
          const right = blur[idx + 4];
          const up = blur[idx - stride];
          const down = blur[idx + stride];
          let nx = (right - left) / 510;
          let ny = (down - up) / 510;
          const px = x * invSw;
          const r1 =
            Math.sin(px * 18 * cfg.roughness + t13) *
            Math.cos(py * 14 * cfg.roughness + t09) *
            0.2 *
            cfg.distortion;
          const r2 = Math.sin((px + py) * 22 * cfg.roughness - t05) * 0.12 * cfg.distortion;
          const r3 = Math.cos(px * 30 * cfg.roughness + py * 10 - t18) * 0.08 * cfg.distortion;

          nx += r1 + r2;
          ny += r3 + r1 * 0.6;

          const envCoord = (nx + r2) * 4 + px * 2 + tEnv;
          let envU = envCoord - Math.floor(envCoord);
          if (envU < 0) envU += 1;
          const envIdx = ((envU * (envLen - 1)) | 0) * 4;
          let cr = envData[envIdx];
          let cg = envData[envIdx + 1];
          let cb = envData[envIdx + 2];

          let envU2 = envU + 0.35 + ny * 2.5;
          envU2 = envU2 - Math.floor(envU2);
          const envIdx2 = ((envU2 * (envLen - 1)) | 0) * 4;
          cr = (cr * 0.65 + envData[envIdx2] * 0.35) | 0;
          cg = (cg * 0.65 + envData[envIdx2 + 1] * 0.35) | 0;
          cb = (cb * 0.65 + envData[envIdx2 + 2] * 0.35) | 0;
          cr = ((cr * (cr + 60)) / 315) | 0;
          cg = ((cg * (cg + 60)) / 315) | 0;
          cb = ((cb * (cb + 60)) / 315) | 0;

          if (isLight) {
            cr = 255 - cr;
            cg = 255 - cg;
            cb = 255 - cb;
            if (cr > 225) cr = 225;
            if (cg > 225) cg = 225;
            if (cb > 223) cb = 223;
          } else {
            if (cr < 30) cr = 30;
            if (cg < 30) cg = 30;
            if (cb < 32) cb = 32;
          }

          if (cfg.tint > 0.01) {
            cr = (cr * (1 + cfg.tint * 0.25)) | 0;
            cg = (cg * (1 + cfg.tint * 0.08)) | 0;
            if (cr > 255) cr = 255;
            if (cg > 255) cg = 255;
          }

          const minEdge =
            left < right
              ? left < up
                ? left < down
                  ? left
                  : down
                : up < down
                  ? up
                  : down
              : right < up
                ? right < down
                  ? right
                  : down
                : up < down
                  ? up
                  : down;
          const edgeness = 1 - minEdge / 255;
          if (edgeness > 0.02) {
            const f = edgeness * edgeness * cfg.fresnel;
            cr = (cr + f * 200) | 0;
            cg = (cg + f * 200) | 0;
            cb = (cb + f * 210) | 0;
          }

          const ldx = px - mx;
          const ldy = py - my;
          const ld2 = ldx * ldx + ldy * ldy;
          if (ld2 < 0.12) {
            const sx = ldx + nx * 0.4;
            const sy = ldy + ny * 0.4;
            const sd = Math.sqrt(sx * sx + sy * sy);
            const sp = 1 - sd * 4.5;
            if (sp > 0) {
              const sp2 = sp * sp;
              const spow = sp2 * sp2 * sp2 * cfg.specular;
              cr = (cr + spow * 240) | 0;
              cg = (cg + spow * 240) | 0;
              cb = (cb + spow * 250) | 0;
            }
          }

          if (cfg.brushAngle > 0.01) {
            const bc2 = px * brushCos + py * brushSin;
            const br = Math.sin(bc2 * 400 * cfg.roughness + nx * 20) * 0.5 + 0.5;
            const bfx = br * 0.15 + 0.85;
            cr = (cr * bfx) | 0;
            cg = (cg * bfx) | 0;
            cb = (cb * bfx) | 0;
          }

          out[idx] = tonemapLUT[cr > 255 ? 255 : cr < 0 ? 0 : cr];
          out[idx + 1] = tonemapLUT[cg > 255 ? 255 : cg < 0 ? 0 : cg];
          out[idx + 2] = tonemapLUT[cb > 255 ? 255 : cb < 0 ? 0 : cb];
          out[idx + 3] = 255;
        }
      }

      shadeContext.putImageData(outImg, 0, 0);

      const introFade =
        introElapsed >= introDuration ? 1 : Math.pow(Math.min(introElapsed / introDuration, 1), 2);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.globalAlpha = introFade;
      ctx.drawImage(shadeCanvas, 0, 0, sw, sh, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const { scale, offsetX, offsetY } = getLogoTransform(
        w,
        h,
        svgScaleRef.current,
        svgWidthRef.current,
        svgHeightRef.current,
      );
      const currentSvg = svgPathRef.current;
      if (currentSvg !== lastGlowSvg) {
        glowPath = new Path2D(currentSvg);
        lastGlowSvg = currentSvg;
      }

      ctx.save();
      ctx.globalCompositeOperation = isLight ? "multiply" : "screen";
      ctx.filter = `blur(${12 + Math.sin(time * 0.3) * 3}px)`;
      ctx.globalAlpha = 0.07 * cfg.fresnel * introFade;
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);
      ctx.fillStyle = glowColorRef.current;
      if (glowPath) ctx.fill(glowPath);
      ctx.restore();

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [buildMask]);

  return (
    <canvas
      aria-hidden
      className={cn("block size-full select-none text-gray-1000", className)}
      ref={canvasRef}
      style={{ touchAction: "none" }}
    />
  );
}

export function HeroMetalShader({ className }: { className?: string }) {
  const scaleOffsetX = (EVE_MARK_WIDTH * (1 - HERO_MARK_SCALE)) / 2;
  const scaleOffsetY = (EVE_MARK_HEIGHT * (1 - HERO_MARK_SCALE)) / 2;

  return (
    <div className={cn("relative size-full", className)}>
      <svg
        aria-hidden
        className="absolute inset-0 size-full text-gray-1000 opacity-[0.12] [mask-image:linear-gradient(90deg,transparent_0%,black_14%,black_78%,transparent_100%)] dark:opacity-20"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1"
        viewBox={`0 0 ${EVE_MARK_WIDTH} ${EVE_MARK_HEIGHT}`}
      >
        <path
          d={EVE_MARK_PATH}
          transform={`translate(${scaleOffsetX} ${scaleOffsetY}) scale(${HERO_MARK_SCALE})`}
        />
      </svg>
      <MetalShader className="absolute inset-0" config={HERO_CONFIG} svgScale={HERO_MARK_SCALE} />
    </div>
  );
}
