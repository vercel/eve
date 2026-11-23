"use client";

import { type ReactNode, useEffect, useRef } from "react";
import styles from "./challenge.module.css";
import { glyphSymbols } from "./glyphs";
import { createHoverFlow } from "./hover-flow";

const prism = ["red", "amber", "green", "teal", "blue", "purple", "pink"];
const sprite = 32;

type Mark = { x: number; y: number; size: number; symbol: number; phase: number };

function makeAtlas(colors: string[]) {
  const atlas = document.createElement("canvas");
  atlas.width = glyphSymbols.length * sprite;
  atlas.height = colors.length * sprite;
  const context = atlas.getContext("2d");
  if (!context) return null;
  for (const [row, color] of colors.entries()) {
    context.fillStyle = context.strokeStyle = color;
    for (const [index, symbol] of glyphSymbols.entries()) {
      context.setTransform(2.8, 0, 0, 2.8, (index + 0.5) * sprite, (row + 0.5) * sprite);
      const path = new Path2D(symbol.path);
      if (symbol.stroke) {
        context.lineWidth = symbol.stroke;
        context.stroke(path);
      } else {
        context.fill(path);
      }
    }
  }
  return atlas;
}

export function GlyphWake({ children }: { children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!surface || !canvas || !context || typeof Path2D !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const styleSheet = getComputedStyle(surface);
    const atlas = makeAtlas(
      prism.map((name) => styleSheet.getPropertyValue(`--ds-${name}-900`).trim() || "#fff"),
    );
    if (!atlas) return;
    const flow = createHoverFlow();
    let marks: Mark[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let elapsed = 0;
    let previous: { x: number; y: number } | undefined;
    let pending: { from: { x: number; y: number }; to: { x: number; y: number } } | undefined;

    function measure() {
      if (!surface || !canvas) return;
      const bounds = surface.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context!.setTransform(dpr, 0, 0, dpr, 0, 0);
      flow.resize(width, height);
      marks = Array.from(
        surface.querySelectorAll<SVGSVGElement>('svg[data-glyph-shape="logo"]'),
      ).flatMap((svg) => {
        const matrix = svg.getScreenCTM();
        if (!matrix) return [];
        return Array.from(svg.querySelectorAll<SVGUseElement>("use")).flatMap((use, index) => {
          const point = new DOMPoint(Number(use.getAttribute("x")), Number(use.getAttribute("y")));
          const { x, y } = point.matrixTransform(matrix);
          const local = { x: x - bounds.left, y: y - bounds.top };
          if (local.x < -16 || local.y < -16 || local.x > width + 16 || local.y > height + 16) {
            return [];
          }
          return [
            {
              ...local,
              size: 16 * matrix.a,
              symbol: Number(use.getAttribute("href")?.split("-").at(-1) ?? 0),
              phase: (index * 0.618) % 1,
            },
          ];
        });
      });
    }

    function draw(now: number) {
      frame = 0;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      elapsed += dt;
      flow.step(dt, pending?.from, pending?.to);
      pending = undefined;
      context!.clearRect(0, 0, width, height);
      for (const mark of marks) {
        const { density, vx, vy } = flow.sample(mark.x, mark.y);
        if (density < 0.035) continue;
        const angle = Math.atan2(vy, vx) / (2 * Math.PI) + 0.5;
        const hue =
          Math.floor(
            ((mark.x + mark.y) / 260 + angle * 0.5 + mark.phase * 0.25 + elapsed * 0.4) *
              prism.length,
          ) % prism.length;
        context!.globalAlpha = Math.min(1, density * 1.2) * 0.5;
        context!.drawImage(
          atlas!,
          mark.symbol * sprite,
          hue * sprite,
          sprite,
          sprite,
          mark.x - mark.size / 2,
          mark.y - mark.size / 2,
          mark.size,
          mark.size,
        );
      }
      context!.globalAlpha = 1;
      if (flow.active() || pending) frame = requestAnimationFrame(draw);
      else last = 0;
    }

    function move(event: PointerEvent) {
      if (!surface) return;
      const bounds = surface.getBoundingClientRect();
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      if (event.pointerType === "touch" && event.type === "pointerdown") {
        pending = { from: { x: point.x - 18, y: point.y - 6 }, to: point };
      } else if (previous) {
        pending = { from: pending?.from ?? previous, to: point };
      }
      previous = point;
      if (!frame) frame = requestAnimationFrame(draw);
    }

    function leave() {
      previous = undefined;
    }

    const size = new ResizeObserver(measure);
    measure();
    size.observe(surface);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerdown", move);
    surface.addEventListener("pointerleave", leave);
    return () => {
      size.disconnect();
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerdown", move);
      surface.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={styles.wake} ref={surfaceRef}>
      {children}
      <canvas aria-hidden="true" className={styles.wakeCanvas} ref={canvasRef} />
    </div>
  );
}
