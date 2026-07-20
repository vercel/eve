// Owns paint target state as one unit, including ping-pong parity and decay/noise/debug passes.
// INVARIANT: readIsPing flips only after encoding a decay pass; front rendering samples current read texture.
// Imported only by render/renderer.ts.

import { Device } from "@vgpu/core";
import { RenderPass } from "@vgpu/render";
import { createPaintDebugBindGroup, createPaintDecayBindGroup } from "./bindings";
import {
  DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
  DEFAULT_PAINT_BRUSH_RADIUS,
  DEFAULT_PAINT_BRUSH_STRENGTH,
  DEFAULT_PAINT_DECAY_RATE,
  DEFAULT_PAINT_DIFFUSION_JITTER,
  DEFAULT_PAINT_DIFFUSION_RATE,
  DEFAULT_PAINT_DT,
  PAINT_STROKE_MOVEMENT_EPSILON_CELLS,
  imprintGridSizeForLogicalSize,
} from "./constants";
import { mix } from "./math";
import { paintMappingMetrics } from "./pointer-mapping";
import type { RendererResources } from "./resources";
import {
  createPaintStaticNoiseTexture,
  createPaintTexture,
  createVoronoiNoiseTexture,
  uploadStaticNoiseTexture,
} from "./textures";
import type {
  ImprintRenderOptions,
  MeshData,
  PaintRenderOptions,
  PaintSeed,
  PaintTargets,
  RenderControls,
} from "./types";

export function createPaintSystem(device: Device, resources: RendererResources, mesh: MeshData) {
  let targets: PaintTargets | undefined;

  const dispose = () => {
    targets?.ping.destroy();
    targets?.pong.destroy();
    targets?.staticNoise.destroy();
    targets?.voronoiValue.destroy();
    targets?.voronoiEdge.destroy();
    targets = undefined;
  };

  const ensure = (logicalWidth: number, logicalHeight: number, gridScaleMultiplier?: number) => {
    const { cols, rows } = imprintGridSizeForLogicalSize(
      logicalWidth,
      logicalHeight,
      gridScaleMultiplier,
    );
    if (targets?.cols === cols && targets.rows === rows) return targets;
    dispose();
    const ping = createPaintTexture(device, "eve-5-paint-ping", cols, rows);
    const pong = createPaintTexture(device, "eve-5-paint-pong", cols, rows);
    const staticNoise = createPaintStaticNoiseTexture(
      device,
      "eve-5-paint-static-noise",
      cols,
      rows,
    );
    const voronoiValue = createVoronoiNoiseTexture(device, "eve-5-ascii-voronoi-value", cols, rows);
    const voronoiEdge = createVoronoiNoiseTexture(device, "eve-5-ascii-voronoi-edge", cols, rows);
    uploadStaticNoiseTexture(device, staticNoise, cols, rows);
    targets = {
      cols,
      rows,
      ping,
      pong,
      staticNoise,
      voronoiValue,
      voronoiEdge,
      readIsPing: true,
      pingReadBindGroup: createPaintDecayBindGroup(
        device,
        resources.pipelines.paintDecayPipeline,
        ping.createView(),
        staticNoise.createView(),
        resources.buffers.paintParamsBuffer,
        "eve-5-paint-decay-read-ping",
      ),
      pongReadBindGroup: createPaintDecayBindGroup(
        device,
        resources.pipelines.paintDecayPipeline,
        pong.createView(),
        staticNoise.createView(),
        resources.buffers.paintParamsBuffer,
        "eve-5-paint-decay-read-pong",
      ),
      pingDebugBindGroup: createPaintDebugBindGroup(
        device,
        resources.pipelines.paintDebugPipeline,
        ping.createView(),
        "eve-5-paint-debug-ping",
      ),
      pongDebugBindGroup: createPaintDebugBindGroup(
        device,
        resources.pipelines.paintDebugPipeline,
        pong.createView(),
        "eve-5-paint-debug-pong",
      ),
    };
    return targets;
  };

  const uploadSeed = (paintTargets: PaintTargets, seed: PaintSeed) => {
    if (seed.width !== paintTargets.cols || seed.height !== paintTargets.rows) {
      throw new Error(
        `Paint seed dimensions ${seed.width}×${seed.height} do not match paint grid ${paintTargets.cols}×${paintTargets.rows}.`,
      );
    }
    if (seed.values.length !== paintTargets.cols * paintTargets.rows) {
      throw new Error(
        `Paint seed has ${seed.values.length} values, expected ${paintTargets.cols * paintTargets.rows}.`,
      );
    }
    paintTargets.readIsPing = true;
    device.gpu.queue.writeTexture(
      { texture: paintTargets.ping },
      seed.values as GPUAllowSharedBufferSource,
      {
        bytesPerRow: paintTargets.cols * Float32Array.BYTES_PER_ELEMENT,
        rowsPerImage: paintTargets.rows,
      },
      { width: paintTargets.cols, height: paintTargets.rows },
    );
  };

  const paintStepOptions = (
    paint: PaintRenderOptions,
    step: number,
    steps: number,
  ): PaintRenderOptions => {
    const stroke = paint.stroke;
    if (!stroke) {
      return {
        ...paint,
        seed: undefined,
        steps: undefined,
        decaySteps: undefined,
        brushActive: false,
      };
    }
    const denominator = Math.max(1, steps - 1);
    const t = steps <= 1 ? 1 : step / denominator;
    const brushCell = [
      mix(stroke.fromCell[0], stroke.toCell[0], t),
      mix(stroke.fromCell[1], stroke.toCell[1], t),
    ] as const;
    const previousT = steps <= 1 ? t : Math.max(0, step - 1) / denominator;
    const previousBrushCell = [
      mix(stroke.fromCell[0], stroke.toCell[0], previousT),
      mix(stroke.fromCell[1], stroke.toCell[1], previousT),
    ] as const;
    const dx = brushCell[0] - previousBrushCell[0];
    const dy = brushCell[1] - previousBrushCell[1];
    const moved = Math.hypot(dx, dy) >= PAINT_STROKE_MOVEMENT_EPSILON_CELLS;
    return {
      ...paint,
      seed: undefined,
      steps: undefined,
      stroke: undefined,
      decaySteps: undefined,
      brushCell,
      brushPreviousCell: previousBrushCell,
      brushActive: stroke.movementGated === false || moved,
      dt: stroke.duration !== undefined && steps > 0 ? stroke.duration / steps : paint.dt,
    };
  };

  const renderDecay = (paintTargets: PaintTargets, paint: PaintRenderOptions = {}) => {
    const dt = Math.min(Math.max(paint.dt ?? DEFAULT_PAINT_DT, 0), 0.1);
    const brushCell = paint.brushCell ?? [-1000000, -1000000];
    const brushPreviousCell = paint.brushPreviousCell ?? brushCell;
    resources.buffers.paintParamsBuffer.write(
      new Float32Array([
        brushCell[0],
        brushCell[1],
        brushPreviousCell[0],
        brushPreviousCell[1],
        paint.brushRadius ?? DEFAULT_PAINT_BRUSH_RADIUS,
        paint.brushStrength ?? DEFAULT_PAINT_BRUSH_STRENGTH,
        paint.decayRate ?? DEFAULT_PAINT_DECAY_RATE,
        paint.diffusionRate ?? DEFAULT_PAINT_DIFFUSION_RATE,
        paint.diffusionJitter ?? DEFAULT_PAINT_DIFFUSION_JITTER,
        dt,
        paint.brushActive ? 1 : 0,
        0,
      ]),
    );
    const readBindGroup = paintTargets.readIsPing
      ? paintTargets.pingReadBindGroup
      : paintTargets.pongReadBindGroup;
    const writeTexture = paintTargets.readIsPing ? paintTargets.pong : paintTargets.ping;
    const pass = new RenderPass(device, {
      label: "eve-5-paint-decay-pass",
      colorAttachments: [
        {
          view: writeTexture.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(resources.pipelines.paintDecayPipeline);
    pass.setBindGroup(0, readBindGroup);
    pass.draw(3);
    pass.end();
    paintTargets.readIsPing = !paintTargets.readIsPing;
  };

  const apply = (paintTargets: PaintTargets, paint: PaintRenderOptions | undefined) => {
    if (paint?.seed) {
      uploadSeed(paintTargets, paint.seed);
    }
    if (paint?.seed || paint?.stroke) {
      const steps = Math.max(0, Math.floor(paint.steps ?? 0));
      for (let step = 0; step < steps; step += 1) {
        renderDecay(paintTargets, paintStepOptions(paint, step, steps));
      }
      const decaySteps = Math.max(0, Math.floor(paint.decaySteps ?? 0));
      for (let step = 0; step < decaySteps; step += 1) {
        renderDecay(paintTargets, {
          ...paint,
          seed: undefined,
          steps: undefined,
          stroke: undefined,
          decaySteps: undefined,
          brushActive: false,
        });
      }
    } else {
      renderDecay(paintTargets, paint);
    }
  };

  const renderVoronoiNoise = (
    paintTargets: PaintTargets,
    controls: RenderControls,
    logicalWidth: number,
    logicalHeight: number,
    projectionPaddingRadius: number,
    imprint: ImprintRenderOptions = {},
  ) => {
    const metrics = paintMappingMetrics(
      mesh.bounds,
      controls,
      logicalWidth,
      logicalHeight,
      imprint.gridScaleMultiplier ?? DEFAULT_IMPRINT_GRID_SCALE_MULTIPLIER,
      projectionPaddingRadius,
      imprint.devicePixelRatio,
    );
    resources.buffers.voronoiNoiseParamsBuffer.write(
      new Float32Array([
        metrics.gridScale,
        imprint.time ?? 0,
        metrics.originCell[0],
        metrics.originCell[1],
      ]),
    );
    const pass = new RenderPass(device, {
      label: "eve-5-ascii-voronoi-noise-pass",
      colorAttachments: [
        {
          view: paintTargets.voronoiValue.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
        {
          view: paintTargets.voronoiEdge.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(resources.pipelines.voronoiNoisePipeline);
    pass.setBindGroup(0, resources.voronoiNoiseBindGroup);
    pass.draw(3);
    pass.end();
  };

  const renderDebug = (view: GPUTextureView, paintTargets: PaintTargets) => {
    const pass = new RenderPass(device, {
      label: "eve-5-paint-debug-pass",
      colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(resources.pipelines.paintDebugPipeline);
    pass.setBindGroup(
      0,
      paintTargets.readIsPing ? paintTargets.pingDebugBindGroup : paintTargets.pongDebugBindGroup,
    );
    pass.draw(3);
    pass.end();
  };

  return { ensure, apply, renderVoronoiNoise, renderDebug, dispose };
}
