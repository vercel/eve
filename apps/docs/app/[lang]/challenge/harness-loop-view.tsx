"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./challenge.module.css";
import { glyphSymbols } from "./glyphs";
import {
  loopHeight,
  loopMarkOpacity,
  loopMarks,
  loopWidth,
  runPositions,
  stillLoop,
} from "./harness-loop";
import { createHoverFlow } from "./hover-flow";

const prism = ["red", "amber", "green", "teal", "blue", "purple", "pink"];
const sprite = 32;

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

export function HarnessLoop() {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!frame || !canvas || !context || typeof Path2D !== "function") return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches) return;
    let palette = "";
    let atlas: HTMLCanvasElement | null = null;
    const paint = () => {
      const styleSheet = getComputedStyle(frame);
      const colors = [
        styleSheet.color,
        ...prism.map((name) => styleSheet.getPropertyValue(`--ds-${name}-900`).trim()),
      ];
      const next = colors.join("|");
      if (next === palette && atlas) return atlas;
      palette = next;
      atlas = makeAtlas(colors.map((color) => color || styleSheet.color)) ?? atlas;
      return atlas;
    };
    if (!paint()) return;
    const flow = createHoverFlow();
    flow.resize(loopWidth, loopHeight);
    let animation = 0;
    let last = 0;
    let elapsed = 0;
    let visible = true;
    let shown = false;
    let previous: { x: number; y: number } | undefined;
    let pending: { from: { x: number; y: number }; to: { x: number; y: number } } | undefined;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio, 2);
      canvas!.width = Math.round(canvas!.clientWidth * dpr);
      canvas!.height = Math.round(canvas!.clientHeight * dpr);
      context!.setTransform(canvas!.width / loopWidth, 0, 0, canvas!.height / loopHeight, 0, 0);
    }

    function draw(now: number) {
      animation = 0;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      elapsed += dt;
      flow.step(dt, pending?.from, pending?.to);
      pending = undefined;
      const runs = runPositions(elapsed);
      const glyphs = paint();
      if (!glyphs) return;
      const strength = Number(getComputedStyle(frame!).getPropertyValue("--loop-strength")) || 1;
      context!.clearRect(0, 0, loopWidth, loopHeight);
      for (const mark of loopMarks) {
        const tile = mark.symbol * sprite;
        const left = mark.x - mark.size / 2;
        const top = mark.y - mark.size / 2;
        context!.globalAlpha = loopMarkOpacity(mark, runs) * strength;
        context!.drawImage(glyphs, tile, 0, sprite, sprite, left, top, mark.size, mark.size);
        const { density, vx, vy } = flow.sample(mark.x, mark.y);
        if (density < 0.035 || mark.shade < 0.1) continue;
        const angle = Math.atan2(vy, vx) / (2 * Math.PI) + 0.5;
        const hue =
          Math.floor(((mark.x + mark.y) / 220 + angle * 0.5 + elapsed * 0.4) * prism.length) %
          prism.length;
        context!.globalAlpha = Math.min(1, density * 1.2) * 0.55;
        context!.drawImage(
          glyphs,
          tile,
          (hue + 1) * sprite,
          sprite,
          sprite,
          left,
          top,
          mark.size,
          mark.size,
        );
      }
      context!.globalAlpha = 1;
      if (!shown) {
        shown = true;
        setAnimated(true);
      }
      if (visible && !document.hidden) animation = requestAnimationFrame(draw);
      else last = 0;
    }

    function start() {
      if (!animation && visible && !document.hidden) animation = requestAnimationFrame(draw);
    }

    function move(event: PointerEvent) {
      const bounds = canvas!.getBoundingClientRect();
      if (!bounds.width) return;
      const point = {
        x: ((event.clientX - bounds.left) / bounds.width) * loopWidth,
        y: ((event.clientY - bounds.top) / bounds.height) * loopHeight,
      };
      if (event.pointerType === "touch" && event.type === "pointerdown") {
        pending = { from: { x: point.x - 18, y: point.y - 6 }, to: point };
      } else if (previous) {
        pending = { from: pending?.from ?? previous, to: point };
      }
      previous = point;
    }

    function leave() {
      previous = undefined;
    }

    const visibility = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      start();
    });
    const size = new ResizeObserver(resize);
    const surface = frame.closest("section") ?? frame;
    resize();
    size.observe(canvas);
    visibility.observe(frame);
    document.addEventListener("visibilitychange", start);
    surface.addEventListener("pointermove", move as EventListener);
    surface.addEventListener("pointerdown", move as EventListener);
    surface.addEventListener("pointerleave", leave);
    return () => {
      size.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", start);
      surface.removeEventListener("pointermove", move as EventListener);
      surface.removeEventListener("pointerdown", move as EventListener);
      surface.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(animation);
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className={styles.loop}
      ref={frameRef}
      style={{ aspectRatio: `${loopWidth} / ${loopHeight}` }}
    >
      <svg
        className={styles.loopStill}
        data-hidden={animated || undefined}
        fill="none"
        viewBox={`0 0 ${loopWidth} ${loopHeight}`}
      >
        <defs>
          {glyphSymbols.map(({ path, stroke }, index) => (
            <path
              d={path}
              fill={stroke ? "none" : "currentColor"}
              id={`challenge-loop-${index}`}
              key={path}
              stroke={stroke ? "currentColor" : undefined}
              strokeWidth={stroke}
              transform="scale(1.4)"
            />
          ))}
        </defs>
        {stillLoop.marks.map((mark, index) => (
          <use
            href={`#challenge-loop-${mark.symbol}`}
            key={index}
            opacity={mark.opacity}
            transform={mark.transform}
          />
        ))}
      </svg>
      <canvas className={styles.loopCanvas} ref={canvasRef} />
    </div>
  );
}
