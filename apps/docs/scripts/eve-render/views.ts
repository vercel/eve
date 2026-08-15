import { resolve } from "node:path";
import type { Device } from "@vgpu/core";
import {
  createEve5Renderer,
  type ImprintRenderOptions,
  type PaintSeed,
  type RenderControls,
} from "../../app/[lang]/(home)/components/eve-logo-shader/render";
import type { RenderConfig } from "./config";
import { formatProgressForFile, readNoiseTimeEnv, stageFileName } from "./env";
import { paintOptions, paintRequested } from "./paint-fixtures";
import { pixelStats, writePng } from "./report";

// Owns offline view orchestration, filenames, and GPU readback.
// INVARIANT: output filenames and manifest keys are byte-identical to the original script.
// Imported only by render-eve-5.ts.

export async function renderDefaultViews(
  renderer: ReturnType<typeof createEve5Renderer>,
  device: Device,
  config: RenderConfig,
  controls: RenderControls,
  paintSeed: PaintSeed | undefined,
) {
  const output = await renderView(
    renderer,
    device,
    config,
    controls,
    outputFileName(config),
    paintSeed,
  );
  await renderView(
    renderer,
    device,
    config,
    {
      ...controls,
      yaw: config.renderYaw || -0.49,
      pitch: config.renderYaw ? controls.pitch : 0.31,
    },
    "rotated.png",
    paintSeed,
  );
  await renderView(
    renderer,
    device,
    config,
    { ...controls, wireframe: true },
    "wireframe.png",
    paintSeed,
  );

  return {
    files: {
      output: outputFileName(config),
      rotated: "rotated.png",
      wireframe: "wireframe.png",
      log: "log.json",
    },
    output: pixelStats(config.width, config.height, output),
  };
}

function outputFileName(config: RenderConfig) {
  const stagePrefix = config.renderStage === "glass" ? "" : `${stageFileName(config.renderStage)}-`;
  const imprintPart =
    config.imprintProgress === undefined
      ? "output"
      : `imprint-${formatProgressForFile(config.imprintProgress)}`;
  const paintPart = paintRequested() ? `-paint-steps-${config.paintSteps}` : "";
  return `${stagePrefix}${imprintPart}${paintPart}.png`;
}

function imprintOptions(
  config: RenderConfig,
  paintSeed?: PaintSeed,
): ImprintRenderOptions | undefined {
  const paint = paintSeed ? paintOptions(config, paintSeed) : undefined;
  if (config.imprintProgress === undefined && !paint) return undefined;
  return {
    progress: config.imprintProgress ?? 0,
    gridScaleMultiplier: config.imprintGridScaleMultiplier,
    glyphScale: config.imprintGlyphScale,
    time: readNoiseTimeEnv(),
    mouse: [0, 0] as const,
    devicePixelRatio: config.dpr,
    paint,
  };
}

async function renderView(
  renderer: ReturnType<typeof createEve5Renderer>,
  device: Device,
  config: RenderConfig,
  controls: RenderControls,
  file: string,
  paintSeed?: PaintSeed,
) {
  const target = device.createTexture({
    label: `eve-5-static-${file}`,
    size: [config.width, config.height],
    format: config.format,
    usage: ["render_attachment", "copy_src"],
  });
  try {
    renderer.render(
      target.createView(),
      controls,
      config.logicalWidth,
      config.logicalHeight,
      imprintOptions(config, paintSeed),
    );
    await device.queue.flush();
    const pixels = new Uint8Array(await target.read());
    await writePng(resolve(config.outDir, file), config.width, config.height, pixels);
    return pixels;
  } finally {
    target.destroy();
  }
}
