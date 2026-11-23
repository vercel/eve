"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createGlyphSea, type PrismTrace, type SeaPoint } from "./glyph-sea";
import poster from "./poster.module.css";

export function GlyphSeaView({
  children,
  silhouette,
}: {
  children: ReactNode;
  silhouette: ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const silhouetteRef = useRef<HTMLDivElement>(null);
  const [canAnimate, setCanAnimate] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setCanAnimate(!media.matches && typeof Path2D === "function");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!canAnimate) return;
    const surface = surfaceRef.current;
    const canvas = canvasRef.current;
    const logo = silhouetteRef.current?.querySelector("svg");
    const title = surface?.querySelector("h1");
    if (!surface || !canvas || !logo || !title) return;
    const renderer = createGlyphSea(canvas, logo);
    if (!renderer) return;
    let previous: SeaPoint | undefined;
    let previousAt = 0;
    let trace: PrismTrace | undefined;
    let hover: PrismTrace | undefined;
    let frame = 0;
    let lastFrame: number | undefined;
    let elapsed = 0;
    let visible = false;

    function draw(now: number) {
      frame = 0;
      const dt = lastFrame === undefined ? 16.7 : now - lastFrame;
      if (dt >= 16) {
        const step = Math.min(dt, 64) / 1000;
        elapsed += step;
        lastFrame = now;
        renderer?.draw(elapsed, step, trace ?? hover);
        trace = undefined;
        surface?.toggleAttribute("data-moving", true);
      }
      sync();
    }

    function sync() {
      if (visible && !document.hidden) {
        if (!frame) frame = requestAnimationFrame(draw);
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        lastFrame = undefined;
        previous = undefined;
        trace = undefined;
        hover = undefined;
      }
    }

    function move(event: PointerEvent) {
      if (!surface || !renderer || (event.pointerType === "touch" && event.type !== "pointerdown"))
        return;
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const next = renderer.point(
        (event.clientX - bounds.left) / bounds.width,
        (event.clientY - bounds.top) / bounds.height,
      );
      const radius = Math.min(
        165,
        Math.max(60, ((renderer.point(1, 0).x - renderer.point(0, 0).x) / bounds.width) * 88),
      );
      const glint = { from: next, to: next, radius, strength: 0.8 };
      hover = event.pointerType === "touch" ? undefined : glint;
      if (event.type === "pointerdown") {
        trace = glint;
      } else if (previous && event.timeStamp - previousAt < 110) {
        trace = { from: trace?.from ?? previous, to: next, radius, strength: 0.94 };
      }
      previous = next;
      previousAt = event.timeStamp;
    }

    function leave() {
      previous = undefined;
      hover = undefined;
    }

    const visibility = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      sync();
    });
    const resize = () => {
      renderer.resize(title.clientWidth, title.clientHeight);
      previous = undefined;
      trace = undefined;
      hover = undefined;
      if (visible && !document.hidden) renderer.draw(elapsed, 0);
    };
    const size = new ResizeObserver(resize);
    resize();
    visibility.observe(surface);
    size.observe(surface);
    size.observe(title);
    document.addEventListener("visibilitychange", sync);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerdown", move);
    surface.addEventListener("pointerleave", leave);
    return () => {
      visibility.disconnect();
      size.disconnect();
      document.removeEventListener("visibilitychange", sync);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerdown", move);
      surface.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(frame);
      surface.removeAttribute("data-moving");
    };
  }, [canAnimate]);

  return (
    <div className={poster.poster}>
      <div aria-hidden="true" hidden ref={silhouetteRef}>
        {silhouette}
      </div>
      <div className={poster.surface} ref={surfaceRef}>
        {children}
        <canvas className={poster.canvas} aria-hidden="true" ref={canvasRef} />
      </div>
    </div>
  );
}
