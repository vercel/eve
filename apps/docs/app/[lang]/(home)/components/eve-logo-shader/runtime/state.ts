import type { MutableRefObject } from "react";
import type { MeshData, RenderControls } from "../render";

// Owns the mutable fields shared by pointer input and the draw loop.
// INVARIANT: this remains one lifecycle state object owned by index.tsx's single effect.
// Imported only by runtime modules and index.tsx.

export type HeroRuntimeState = {
  cancelled: boolean;
  animationFrame: number;
  cleanup: (() => void) | undefined;
  mouseEnvYaw: number;
  targetMouseEnvYaw: number;
  mouseEnvPitch: number;
  targetMouseEnvPitch: number;
  asciiMouseX: number;
  asciiMouseY: number;
  targetAsciiMouseX: number;
  targetAsciiMouseY: number;
  brushCellX: number;
  brushCellY: number;
  previousRenderedBrushCellX: number;
  previousRenderedBrushCellY: number;
  hasBrushCell: boolean;
  hasRenderedBrushCell: boolean;
  brushActive: boolean;
  paintGridScaleMultiplier: number;
  targetBrushActive: boolean;
  activeMesh: MeshData | undefined;
  agentsEnvYawMix: number;
  previousFrameTime: number;
  autoRotateStartTime: number;
  lastBrushMoveTime: number;
  lastPointerClientX: number | undefined;
  lastPointerClientY: number | undefined;
  isCoarsePointer: boolean;
};

export type ControlsRef = MutableRefObject<RenderControls>;
