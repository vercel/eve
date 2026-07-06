// This script uses @vgpu/adapter-node, which requires native Vulkan support and a
// new-enough GLIBC. Run it inside the software-Vulkan Docker image when baking
// the static Eve logo fallback:
//
//   docker run --rm \
//     -v /home/user/eve-worktrees/eve-migrate-shader:/work \
//     -w /work/apps/docs \
//     -e VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
//     -e LIBGL_ALWAYS_SOFTWARE=1 \
//     -e EVE_LOGO_RENDER_THEME=dark \
//     -e EVE_LOGO_RENDER_WIDTH=1095 \
//     -e EVE_LOGO_RENDER_HEIGHT=348 \
//     -e EVE_LOGO_RENDER_PADDING=0 \
//     -e EVE_LOGO_RENDER_BLOOM=0 \
//     browser-webgpu-lab:native-vgpu-node \
//     bash -lc 'xvfb-run -a bash -lc "NODE_OPTIONS=--loader=./scripts/wgsl-node-loader.mjs ./node_modules/.bin/tsx scripts/render-eve-5.ts"'
//
// The Docker image provides GLIBC 2.41, lavapipe/llvmpipe, libvulkan, and xvfb.
// Convert the generated tmp/eve-5-renders/<run>/output.png to the desired
// public/eve-5/fallback-<theme>.webp with ImageMagick from the same container.
// Set EVE_LOGO_RENDER_THEME=light|dark and EVE_LOGO_RENDER_WIDTH/HEIGHT when
// baking production fallbacks. Fallback images are content-only: render without
// bloom or padding, then place them inside the padded canvas box in CSS so the
// animated shader appears to "turn on" around the same logo geometry.

import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "@vgpu/core";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { PNG } from "pngjs";
import { decodeGltfMesh } from "../app/[lang]/(home)/components/eve-logo-shader/mesh";
import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH_OFF,
  BLOOM_STRENGTH_ON,
  BLOOM_THRESHOLD,
  DEFAULT_CAMERA_FOV,
  cameraRadiusForFov,
  createEve5Renderer,
  getPaddedRenderSize,
  type EveMaterial,
  type MeshData,
  type RenderControls,
} from "../app/[lang]/(home)/components/eve-logo-shader/render";

const RUN_ID = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const OUT_DIR = resolve(process.cwd(), "tmp/eve-5-renders", RUN_ID);
const FORMAT: GPUTextureFormat = "rgba8unorm";
const PADDING_RADIUS = readNonNegativeIntegerEnv("EVE_LOGO_RENDER_PADDING", 0);
const BLOOM_ENABLED = readBooleanEnv("EVE_LOGO_RENDER_BLOOM", false);
const OUTPUT_WIDTH = readPositiveIntegerEnv("EVE_LOGO_RENDER_WIDTH", 1095, PADDING_RADIUS * 2);
const OUTPUT_HEIGHT = readPositiveIntegerEnv("EVE_LOGO_RENDER_HEIGHT", 348, PADDING_RADIUS * 2);
const LOGICAL_WIDTH = Math.max(1, OUTPUT_WIDTH - PADDING_RADIUS * 2);
const LOGICAL_HEIGHT = Math.max(1, OUTPUT_HEIGHT - PADDING_RADIUS * 2);
const PADDED_SIZE = getPaddedRenderSize(LOGICAL_WIDTH, LOGICAL_HEIGHT, PADDING_RADIUS);
const WIDTH = PADDED_SIZE.width;
const HEIGHT = PADDED_SIZE.height;
const THEME = readThemeEnv();
const IMPRINT_PROGRESS = readUnitIntervalEnv("EVE_LOGO_RENDER_IMPRINT_PROGRESS");
const IMPRINT_GRID_SCALE_MULTIPLIER = readPositiveNumberEnv("EVE_LOGO_IMPRINT_GRID_SCALE_MULTIPLIER", 1);
const IMPRINT_GLYPH_SCALE = readPositiveNumberEnv("EVE_LOGO_IMPRINT_GLYPH_SCALE", 1.35);
const REQUESTED_RENDER_STAGE = readRenderStageEnv();
const RENDER_STAGE: EveMaterial = REQUESTED_RENDER_STAGE;
const RENDER_YAW = readFiniteNumberEnv("EVE_LOGO_RENDER_YAW", 0);
const MODEL_PATH = resolve(process.cwd(), "public/eve-5/eve-logo.gltf");
const DEFAULT_CONTROLS: RenderControls = {
  yaw: RENDER_YAW,
  pitch: 0,
  radius: cameraRadiusForFov(DEFAULT_CAMERA_FOV),
  fov: DEFAULT_CAMERA_FOV,
  envYaw: 0,
  envPitch: 0,
  insideRendering: true,
  outsideRendering: true,
  material: RENDER_STAGE,
  wireframe: false,
  showEnv: false,
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const mesh = await loadMeshFromDisk(MODEL_PATH);
  const app = await App.create({ adapter: createNodeAdapter() });
  let renderer: ReturnType<typeof createEve5Renderer> | undefined;

  try {
    renderer = createEve5Renderer(app.device, FORMAT, mesh, {
      theme: THEME,
      paddingRadius: PADDING_RADIUS,
      bloom: BLOOM_ENABLED,
    });

    const renderResult = await renderDefaultViews(renderer, app.device, DEFAULT_CONTROLS);

    const log = {
      runId: RUN_ID,
      outDir: OUT_DIR,
      dimensions: {
        width: WIDTH,
        height: HEIGHT,
        format: FORMAT,
        theme: THEME,
        stage: RENDER_STAGE,
        requestedStage: REQUESTED_RENDER_STAGE,
      },
      bloom: {
        enabled: BLOOM_ENABLED,
        runtimeRadius: BLOOM_RADIUS,
        radius: PADDING_RADIUS,
        strength: BLOOM_ENABLED ? effectiveBloomStrength(IMPRINT_PROGRESS ?? 0) : 0,
        strengthOff: BLOOM_STRENGTH_OFF,
        strengthOn: BLOOM_STRENGTH_ON,
        threshold: BLOOM_THRESHOLD,
        logical: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
        padded: { width: WIDTH, height: HEIGHT },
      },
      imprint:
        IMPRINT_PROGRESS !== undefined
          ? {
              enabled: true,
              progress: IMPRINT_PROGRESS,
              gridScaleMultiplier: IMPRINT_GRID_SCALE_MULTIPLIER,
              glyphScale: IMPRINT_GLYPH_SCALE,
              noise: { time: readNoiseTimeEnv(), mouse: [0, 0] },
              stage: "front-glass-material-imprint",
            }
          : { enabled: false },
      mesh: {
        vertices: mesh.positions.length / 3,
        triangles: mesh.indices.length / 3,
        bounds: mesh.bounds,
      },
      files: renderResult.files,
      output: renderResult.output,
    };

    const logWithOptionalBounds: typeof log & { bounds?: unknown } = log;
    if ("bounds" in renderResult) {
      logWithOptionalBounds.bounds = renderResult.bounds;
    }

    await writeFile(resolve(OUT_DIR, "log.json"), `${JSON.stringify(log, null, 2)}\n`);
    console.log(JSON.stringify(log, null, 2));

    if (log.output.nonBlack === 0) process.exitCode = 1;
  } finally {
    renderer?.dispose();
    app.device.destroy();
  }
}

async function renderDefaultViews(
  renderer: ReturnType<typeof createEve5Renderer>,
  device: Awaited<ReturnType<typeof App.create>>["device"],
  controls: RenderControls,
) {
  const output = await renderView(renderer, device, controls, outputFileName(), WIDTH, HEIGHT, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  await renderView(renderer, device, { ...controls, yaw: RENDER_YAW || -0.49, pitch: RENDER_YAW ? controls.pitch : 0.31 }, "rotated.png", WIDTH, HEIGHT, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  await renderView(renderer, device, { ...controls, wireframe: true }, "wireframe.png", WIDTH, HEIGHT, LOGICAL_WIDTH, LOGICAL_HEIGHT);

  return {
    files: {
      output: outputFileName(),
      rotated: "rotated.png",
      wireframe: "wireframe.png",
      log: "log.json",
    },
    output: pixelStats(WIDTH, HEIGHT, output),
  };
}

function outputFileName() {
  return IMPRINT_PROGRESS === undefined ? "output.png" : `imprint-${formatProgressForFile(IMPRINT_PROGRESS)}.png`;
}

function effectiveBloomStrength(imprintProgress: number) {
  return BLOOM_STRENGTH_OFF + (BLOOM_STRENGTH_ON - BLOOM_STRENGTH_OFF) * imprintProgress;
}

function imprintOptions() {
  if (IMPRINT_PROGRESS === undefined) return undefined;
  return {
    progress: IMPRINT_PROGRESS,
    gridScaleMultiplier: IMPRINT_GRID_SCALE_MULTIPLIER,
    glyphScale: IMPRINT_GLYPH_SCALE,
    time: readNoiseTimeEnv(),
    mouse: [0, 0] as const,
  };
}

async function renderView(
  renderer: ReturnType<typeof createEve5Renderer>,
  device: Awaited<ReturnType<typeof App.create>>["device"],
  controls: RenderControls,
  file: string,
  width: number,
  height: number,
  logicalWidth: number,
  logicalHeight: number,
) {
  const target = device.createTexture({
    label: `eve-5-static-${file}`,
    size: [width, height],
    format: FORMAT,
    usage: ["render_attachment", "copy_src"],
  });
  try {
    renderer.render(target.createView(), controls, logicalWidth, logicalHeight, imprintOptions());
    await device.queue.flush();
    const pixels = new Uint8Array(await target.read());
    await writePng(resolve(OUT_DIR, file), width, height, pixels);
    return pixels;
  } finally {
    target.destroy();
  }
}

async function loadMeshFromDisk(path: string) {
  const gltf = JSON.parse(await readFile(path, "utf8"));
  return decodeGltfMesh(gltf, async (uri) => {
    if (uri.startsWith("data:application/octet-stream;base64,")) {
      const [, payload] = uri.split(",");
      return exactArrayBuffer(Buffer.from(payload!, "base64"));
    }
    const bufferPath = resolve(path, "..", uri);
    return exactArrayBuffer(await readFile(bufferPath));
  });
}

function readFiniteNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return parsed;
}

function readPositiveIntegerEnv(name: string, fallback: number, minimumExclusive = 0) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= minimumExclusive) {
    throw new Error(`${name} must be an integer greater than ${minimumExclusive}.`);
  }
  return parsed;
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function readUnitIntervalEnv(name: string) {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a finite number between 0 and 1.`);
  }
  return parsed;
}

function readNonNegativeIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) return fallback;
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value.`);
}

function readRenderStageEnv(): EveMaterial {
  const values: Record<string, EveMaterial> = {
    glass: "glass",
    "back-albedo": "back-albedo",
    "back-depth": "back-depth",
    thickness: "thickness",
    normal: "normal",
    "camera-reflected-normal": "camera reflected normal",
    metallic: "metallic",
  };
  const value = process.env.EVE_LOGO_RENDER_STAGE ?? "glass";
  const stage = values[value];
  if (!stage) {
    throw new Error(`EVE_LOGO_RENDER_STAGE must be one of: ${Object.keys(values).join(", ")}.`);
  }
  return stage;
}

function stageFileName(stage: EveMaterial) {
  return stage.replaceAll(" ", "-");
}

function formatProgressForFile(progress: number) {
  return progress.toFixed(3).replace(/0+$/, "").replace(/\.$/, "").replace(".", "p");
}

function readNoiseTimeEnv() {
  const value = process.env.EVE_LOGO_RENDER_NOISE_TIME;
  if (!value) return 0;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("EVE_LOGO_RENDER_NOISE_TIME must be a finite number.");
  }
  return parsed;
}

function readThemeEnv(): "light" | "dark" {
  const value = process.env.EVE_LOGO_RENDER_THEME ?? "dark";
  if (value === "light" || value === "dark") return value;
  throw new Error('EVE_LOGO_RENDER_THEME must be "light" or "dark".');
}

function exactArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function writePng(path: string, width: number, height: number, pixels: Uint8Array) {
  const png = new PNG({ width, height });
  png.data.set(pixels);
  await writeFile(path, PNG.sync.write(png));
}

function pixelStats(width: number, height: number, pixels: Uint8Array) {
  let nonBlack = 0;
  let alpha = 0;
  let colored = 0;

  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index] ?? 0;
    const g = pixels[index + 1] ?? 0;
    const b = pixels[index + 2] ?? 0;
    const a = pixels[index + 3] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 8) nonBlack++;
    if (a > 20) alpha++;
    if (max - min > 8 && r + g + b > 24) colored++;
  }

  const header = Buffer.alloc(8);
  header.writeUInt32LE(width, 0);
  header.writeUInt32LE(height, 4);
  const sha256 = createHash("sha256").update(header).update(pixels).digest("hex");

  return { width, height, total: width * height, nonBlack, alpha, colored, sha256 };
}

await main();
