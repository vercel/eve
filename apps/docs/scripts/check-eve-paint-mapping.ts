import { strict as assert } from "node:assert";
import {
  DEFAULT_CAMERA_FOV,
  BLOOM_RADIUS,
  cameraRadiusForFov,
  DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO,
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
const devicePixelRatio = DEFAULT_IMPRINT_DEVICE_PIXEL_RATIO;
const canvasWidth = Math.floor(rect.width * devicePixelRatio);
const canvasHeight = Math.floor(rect.height * devicePixelRatio);
const logicalWidth = canvasWidth - BLOOM_RADIUS * 2;
const logicalHeight = canvasHeight - BLOOM_RADIUS * 2;
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
  devicePixelRatio,
});
assert(center);
assert.equal(center.insideLogicalBounds, true);
assert.deepEqual(center.originCell, [-21, -7]);
assertAlmost(center.physical[0], 563.5, "center physical x");
assertAlmost(center.physical[1], 190, "center physical y");
assertAlmost(center.logical[0], 547.5, "center logical x");
assertAlmost(center.logical[1], 174, "center logical y");
assertAlmost(center.model[0], 0, "center model x");
assertAlmost(center.model[1], 0, "center model y");
assertAlmost(center.brushCell[0], 21, "center cell x");
assertAlmost(center.brushCell[1], 7, "center cell y");

const dpr1SameBuffer = mapClientPointToPaintCell({
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
  devicePixelRatio: 1,
});
assert(dpr1SameBuffer);
assert.equal(dpr1SameBuffer.insideLogicalBounds, true);
assertAlmost(dpr1SameBuffer.gridScale, center.gridScale * 2, "dpr1 same-buffer grid scale doubles");
assertAlmost(
  dpr1SameBuffer.brushCell[0] - dpr1SameBuffer.originCell[0],
  (center.brushCell[0] - center.originCell[0]) * 2,
  "dpr1 same-buffer center lattice coordinate doubles",
);

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
  devicePixelRatio,
});
assert(leftOfOrigin);
assert.equal(leftOfOrigin.insideLogicalBounds, true);
assert.deepEqual(leftOfOrigin.originCell, [-21, -7]);
assert(leftOfOrigin.model[0] < 0, "left case is in negative model X");
assert(leftOfOrigin.brushCell[0] < 0, "originCell offset preserves negative/out-of-grid cell X");
assertAlmost(leftOfOrigin.logical[0], 0, "left logical x");
assertAlmost(leftOfOrigin.brushCell[0], -3.2953125, "left cell x");
assertAlmost(leftOfOrigin.brushCell[1], 7, "left cell y");

console.log(
  JSON.stringify(
    {
      ok: true,
      center: summarize(center),
      leftOfOrigin: summarize(leftOfOrigin),
      dpr1SameBuffer: summarize(dpr1SameBuffer),
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
