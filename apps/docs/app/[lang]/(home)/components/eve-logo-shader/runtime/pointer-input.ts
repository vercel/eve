import type { RefObject } from "react";
import { evePointerInteractionMode } from "../mobile-motion";
import { bloomRadiusForDevicePixelRatio, mapClientPointToPaintCell } from "../render";
import { getBrowserDevicePixelRatio } from "./canvas-sizing";
import type { ControlsRef, HeroRuntimeState } from "./state";

// Owns browser pointer input for env yaw and paint brush updates.
// INVARIANT: coarse-pointer mode disables paint and switches to env auto-rotate.
// Imported only by index.tsx's single effect.

const MAX_ENV_YAW = 0.3;
const MAX_ENV_PITCH = 0.2;
const PAINT_POINTER_MOVE_EPSILON_PX = 0.5;

export function createPointerController({
  state,
  controlsRef,
  canvasRef,
}: {
  state: HeroRuntimeState;
  controlsRef: ControlsRef;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const coarsePointerQuery = window.matchMedia("(pointer: coarse)");
  const syncPointerInteractionMode = () => {
    state.isCoarsePointer = coarsePointerQuery.matches;
    if (evePointerInteractionMode(state.isCoarsePointer).autoRotateEnvYaw) {
      state.targetBrushActive = false;
      state.targetMouseEnvPitch = 0;
      state.targetAsciiMouseX = 0;
      state.targetAsciiMouseY = 0;
      state.autoRotateStartTime = performance.now();
    }
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
    const devicePixelRatio = getBrowserDevicePixelRatio();
    const paddingRadius = bloomRadiusForDevicePixelRatio(devicePixelRatio);
    const logicalWidth = Math.max(1, canvas.width - paddingRadius * 2);
    const logicalHeight = Math.max(1, canvas.height - paddingRadius * 2);
    const mapping = mapClientPointToPaintCell({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: canvas.getBoundingClientRect(),
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

  syncPointerInteractionMode();
  coarsePointerQuery.addEventListener("change", syncPointerInteractionMode);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerout", deactivateBrush, { passive: true });
  window.addEventListener("blur", deactivateBrush);

  return {
    detach() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", deactivateBrush);
      window.removeEventListener("blur", deactivateBrush);
      coarsePointerQuery.removeEventListener("change", syncPointerInteractionMode);
    },
  };
}
