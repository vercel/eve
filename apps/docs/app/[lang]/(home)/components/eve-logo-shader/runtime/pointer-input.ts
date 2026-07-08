import type { RefObject } from "react";
import { evePointerInteractionMode } from "../mobile-motion";
import { bloomRadiusForDevicePixelRatio, mapClientPointToPaintCell } from "../render";
import {
  getBrowserDevicePixelRatio,
  type CanvasLayoutRef,
  type DevicePixelRatioRef,
} from "./canvas-sizing";
import type { ControlsRef, HeroRuntimeState } from "./state";

// Owns browser pointer input for env yaw and paint brush updates.
// INVARIANT: coarse-pointer mode disables paint and switches to env auto-rotate.
// Imported only by index.tsx's single effect.

const MAX_ENV_YAW = 0.3;
const MAX_ENV_PITCH = 0.2;
const PAINT_POINTER_MOVE_EPSILON_PX = 0.5;

export function syncPointerInteractionMode(state: HeroRuntimeState, isCoarsePointer: boolean) {
  state.isCoarsePointer = isCoarsePointer;
  if (evePointerInteractionMode(state.isCoarsePointer).autoRotateEnvYaw) {
    state.targetBrushActive = false;
    state.targetMouseEnvPitch = 0;
    state.targetAsciiMouseX = 0;
    state.targetAsciiMouseY = 0;
    state.autoRotateStartTime = performance.now();
  }
}

export function createPointerController({
  state,
  controlsRef,
  canvasRef,
  coarsePointerRef,
  canvasLayoutRef,
  devicePixelRatioRef,
}: {
  state: HeroRuntimeState;
  controlsRef: ControlsRef;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  coarsePointerRef: RefObject<boolean>;
  canvasLayoutRef: CanvasLayoutRef;
  devicePixelRatioRef: DevicePixelRatioRef;
}) {
  let cachedCanvasRect: DOMRectReadOnly | undefined;
  let rectInvalidated = true;

  const getCanvasRect = () => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const { width, height } = canvasLayoutRef.current;
    if (
      !cachedCanvasRect ||
      rectInvalidated ||
      cachedCanvasRect.width !== width ||
      cachedCanvasRect.height !== height
    ) {
      const rect = canvas.getBoundingClientRect();
      cachedCanvasRect = new DOMRectReadOnly(
        rect.left,
        rect.top,
        width || rect.width,
        height || rect.height,
      );
      rectInvalidated = false;
    }
    return cachedCanvasRect;
  };

  const invalidateCanvasRect = () => {
    rectInvalidated = true;
  };

  const updateEnvRotation = (clientX: number, clientY: number) => {
    if (evePointerInteractionMode(state.isCoarsePointer).autoRotateEnvYaw) return;
    const viewportWidth = Math.max(1, window.innerWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || 1);
    const clampedX = Math.max(0, Math.min(viewportWidth, clientX));
    const clampedY = Math.max(0, Math.min(viewportHeight, clientY));
    const normalizedX = (clampedX / viewportWidth) * 2 - 1;
    const normalizedY = (clampedY / viewportHeight) * 2 - 1;
    state.targetMouseEnvYaw = normalizedX * MAX_ENV_YAW;
    state.targetMouseEnvPitch = normalizedY * MAX_ENV_PITCH;
    state.targetAsciiMouseX = normalizedX;
    state.targetAsciiMouseY = normalizedY;
  };

  const deactivateBrush = () => {
    state.targetBrushActive = false;
    state.hasBrushCell = false;
    state.hasRenderedBrushCell = false;
    state.lastPointerClientX = undefined;
    state.lastPointerClientY = undefined;
    state.lastBrushMoveTime = Number.NEGATIVE_INFINITY;
  };

  const updatePaintBrush = (event: PointerEvent) => {
    const canvas = canvasRef.current;
    const mesh = state.activeMesh;
    if (
      !canvas ||
      !mesh ||
      event.pointerType !== "mouse" ||
      !evePointerInteractionMode(state.isCoarsePointer).paintEnabled
    ) {
      deactivateBrush();
      return;
    }
    const rect = getCanvasRect();
    if (!rect) {
      deactivateBrush();
      return;
    }
    const devicePixelRatio = getBrowserDevicePixelRatio(devicePixelRatioRef.current);
    const paddingRadius = bloomRadiusForDevicePixelRatio(devicePixelRatio);
    const logicalWidth = Math.max(1, canvas.width - paddingRadius * 2);
    const logicalHeight = Math.max(1, canvas.height - paddingRadius * 2);
    const mapping = mapClientPointToPaintCell({
      clientX: event.clientX,
      clientY: event.clientY,
      rect,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      logicalWidth,
      logicalHeight,
      controls: controlsRef.current,
      meshBounds: mesh.bounds,
      gridScaleMultiplier: state.paintGridScaleMultiplier,
      paddingRadius,
      devicePixelRatio,
    });
    if (!mapping?.insideLogicalBounds) {
      deactivateBrush();
      return;
    }
    const nextBrushCellX = mapping.brushCell[0];
    const nextBrushCellY = mapping.brushCell[1];
    const pointerMoved =
      state.lastPointerClientX === undefined ||
      state.lastPointerClientY === undefined ||
      Math.hypot(
        event.clientX - state.lastPointerClientX,
        event.clientY - state.lastPointerClientY,
      ) >= PAINT_POINTER_MOVE_EPSILON_PX;
    if (pointerMoved) {
      state.lastBrushMoveTime = performance.now();
    }
    state.brushCellX = nextBrushCellX;
    state.brushCellY = nextBrushCellY;
    state.hasBrushCell = true;
    state.lastPointerClientX = event.clientX;
    state.lastPointerClientY = event.clientY;
    state.targetBrushActive = true;
  };

  const onPointerMove = (event: PointerEvent) => {
    updateEnvRotation(event.clientX, event.clientY);
    updatePaintBrush(event);
  };

  syncPointerInteractionMode(state, coarsePointerRef.current);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("scroll", invalidateCanvasRect, { passive: true });
  window.addEventListener("resize", invalidateCanvasRect, { passive: true });
  window.addEventListener("pointerout", deactivateBrush, { passive: true });
  window.addEventListener("blur", deactivateBrush);

  return {
    invalidateCanvasRect,
    detach() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", invalidateCanvasRect);
      window.removeEventListener("resize", invalidateCanvasRect);
      window.removeEventListener("pointerout", deactivateBrush);
      window.removeEventListener("blur", deactivateBrush);
    },
  };
}
