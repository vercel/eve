import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { App } from "@vgpu/core";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { PNG } from "pngjs";
import { decodeGltfMesh } from "../app/[lang]/(home)/components/eve-logo-shader/mesh";
import {
  BLOOM_RADIUS,
  BLOOM_STRENGTH,
  BLOOM_THRESHOLD,
  createEve5Renderer,
  getPaddedRenderSize,
  type RenderControls,
} from "../app/[lang]/(home)/components/eve-logo-shader/render";

const RUN_ID = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const OUT_DIR = resolve(process.cwd(), "tmp/eve-5-renders", RUN_ID);
const FORMAT: GPUTextureFormat = "rgba8unorm";
const LOGICAL_WIDTH = 960;
const LOGICAL_HEIGHT = Math.round(LOGICAL_WIDTH / (78 / 25));
const PADDED_SIZE = getPaddedRenderSize(LOGICAL_WIDTH, LOGICAL_HEIGHT);
const WIDTH = PADDED_SIZE.width;
const HEIGHT = PADDED_SIZE.height;
const MODEL_PATH = resolve(process.cwd(), "public/eve-5/eve-logo.gltf");
const DEFAULT_CONTROLS: RenderControls = {
  yaw: 0,
  pitch: 0,
  radius: 1.9,
  fov: 35,
  envYaw: 0,
  insideRendering: true,
  outsideRendering: true,
  material: "glass",
  wireframe: false,
  showEnv: false,
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const mesh = await loadMeshFromDisk(MODEL_PATH);
  const app = await App.create({ adapter: createNodeAdapter() });
  let renderer: ReturnType<typeof createEve5Renderer> | undefined;

  try {
    renderer = createEve5Renderer(app.device, FORMAT, mesh);
    const output = await renderView(renderer, app.device, DEFAULT_CONTROLS, "output.png");
    await renderView(renderer, app.device, { ...DEFAULT_CONTROLS, yaw: -0.49, pitch: 0.31 }, "rotated.png");
    await renderView(renderer, app.device, { ...DEFAULT_CONTROLS, wireframe: true }, "wireframe.png");

    const log = {
      runId: RUN_ID,
      outDir: OUT_DIR,
      dimensions: { width: WIDTH, height: HEIGHT, format: FORMAT },
      bloom: {
        radius: BLOOM_RADIUS,
        strength: BLOOM_STRENGTH,
        threshold: BLOOM_THRESHOLD,
        logical: { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT },
        padded: { width: WIDTH, height: HEIGHT },
      },
      mesh: {
        vertices: mesh.positions.length / 3,
        triangles: mesh.indices.length / 3,
        bounds: mesh.bounds,
      },
      files: {
        output: "output.png",
        rotated: "rotated.png",
        wireframe: "wireframe.png",
        log: "log.json",
      },
      output: pixelStats(WIDTH, HEIGHT, output),
    };

    await writeFile(resolve(OUT_DIR, "log.json"), `${JSON.stringify(log, null, 2)}\n`);
    console.log(JSON.stringify(log, null, 2));

    if (log.output.nonBlack === 0) process.exitCode = 1;
  } finally {
    renderer?.dispose();
    app.device.destroy();
  }
}

async function renderView(
  renderer: ReturnType<typeof createEve5Renderer>,
  device: Awaited<ReturnType<typeof App.create>>["device"],
  controls: RenderControls,
  file: string,
) {
  const target = device.createTexture({
    label: `eve-5-static-${file}`,
    size: [WIDTH, HEIGHT],
    format: FORMAT,
    usage: ["render_attachment", "copy_src"],
  });
  try {
    renderer.render(target.createView(), controls, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    await device.queue.flush();
    const pixels = new Uint8Array(await target.read());
    await writePng(resolve(OUT_DIR, file), WIDTH, HEIGHT, pixels);
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
