import { strict as assert } from "node:assert";
import {
  DEFAULT_CAMERA_FOV,
  BLOOM_RADIUS,
  cameraRadiusForFov,
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  mapClientPointToPaintCell,
  type Bounds,
  type RenderControls,
} from "../app/[lang]/(home)/components/eve-logo-shader/render";

const bounds: Bounds = {
  min: [-0.039000000804662704, -0.01188180036842823, -0.0020000000949949026],
  max: [0.03870119899511337, 0.012500000186264515, 0.0020000000949949026],
};
const controls: Pick<RenderControls, "radius" | "yaw" | "pitch" | "fov"> = {
  yaw: 0,
  pitch: 0,
  radius: cameraRadiusForFov(DEFAULT_CAMERA_FOV),
  fov: DEFAULT_CAMERA_FOV,
};
const rect = { left: 10, top: 20, width: 563.5, height: 190 };
const canvasWidth = 1127;
const canvasHeight = 380;
const logicalWidth = 1095;
const logicalHeight = 348;
const gridScaleMultiplier = DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER;

const center = mapClientPointToPaintCell({
  clientX: rect.left + rect.width / 2,
  clientY: rect.top + rect.height / 2,
  rect,
  canvasWidth,
  canvasHeight,
  logicalWidth,
  logicalHeight,
  controls,
  meshBounds: bounds,
  gridScaleMultiplier,
});
assert(center);
assert.equal(center.insideLogicalBounds, true);
assert.deepEqual(center.originCell, [-31, -10]);
assertAlmost(center.physical[0], 563.5, "center physical x");
assertAlmost(center.physical[1], 190, "center physical y");
assertAlmost(center.logical[0], 547.5, "center logical x");
assertAlmost(center.logical[1], 174, "center logical y");
assertAlmost(center.model[0], 0, "center model x");
assertAlmost(center.model[1], 0, "center model y");
assertAlmost(center.brushCell[0], 31, "center cell x");
assertAlmost(center.brushCell[1], 10, "center cell y");

const leftEdgeClientX = rect.left + (BLOOM_RADIUS * rect.width) / canvasWidth;
const leftOfOrigin = mapClientPointToPaintCell({
  clientX: leftEdgeClientX,
  clientY: rect.top + rect.height / 2,
  rect,
  canvasWidth,
  canvasHeight,
  logicalWidth,
  logicalHeight,
  controls,
  meshBounds: bounds,
  gridScaleMultiplier,
});
assert(leftOfOrigin);
assert.equal(leftOfOrigin.insideLogicalBounds, true);
assert.deepEqual(leftOfOrigin.originCell, [-31, -10]);
assert(leftOfOrigin.model[0] < 0, "left case is in negative model X");
assert(leftOfOrigin.brushCell[0] < 0, "originCell offset preserves negative/out-of-grid cell X");
assertAlmost(leftOfOrigin.logical[0], 0, "left logical x");
assertAlmost(leftOfOrigin.brushCell[0], -4.2453125, "left cell x");
assertAlmost(leftOfOrigin.brushCell[1], 10, "left cell y");

console.log(
  JSON.stringify(
    {
      ok: true,
      center: summarize(center),
      leftOfOrigin: summarize(leftOfOrigin),
    },
    null,
    2,
  ),
);

function summarize(mapping: NonNullable<ReturnType<typeof mapClientPointToPaintCell>>) {
  return {
    physical: roundPair(mapping.physical),
    logical: roundPair(mapping.logical),
    model: roundPair(mapping.model),
    brushCell: roundPair(mapping.brushCell),
    originCell: mapping.originCell,
    gridScale: round(mapping.gridScale),
    pxPerModelUnit: round(mapping.pxPerModelUnit),
    insideLogicalBounds: mapping.insideLogicalBounds,
  };
}

function roundPair(pair: readonly [number, number]) {
  return [round(pair[0]), round(pair[1])] as const;
}

function round(value: number) {
  return Number(value.toFixed(6));
}

function assertAlmost(actual: number, expected: number, label: string) {
  assert(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, received ${actual}`);
}
