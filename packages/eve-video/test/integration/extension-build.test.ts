import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "node:test";

import type { ToolDefinition } from "eve/tools";

import type extensionType from "../../extension/extension.ts";
import type * as coreType from "../../extension/lib/core.ts";
import type * as storageType from "../../extension/lib/storage/index.ts";
import type * as vercelStorageType from "../../extension/lib/storage/vercel-blob.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
} from "../../extension/lib/types.ts";
import { MP4_BYTES, createAsyncVideoModel, executeGenerateTool } from "../helpers.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

interface BuiltIndexModule {
  readonly default: typeof extensionType;
  readonly video: typeof extensionType;
}

interface BuiltToolsModule {
  readonly generate: ToolDefinition<
    GenerateVideoToolInput,
    GenerateVideoToolProgress | GenerateVideoToolOutput
  >;
}

async function importBuiltModule<T>(relativePath: string): Promise<T> {
  const url = new URL(relativePath, import.meta.url).href;
  return (await import(url)) as T;
}

const builtIndex = await importBuiltModule<BuiltIndexModule>("../../dist/index.mjs");
const builtTools = await importBuiltModule<BuiltToolsModule>("../../dist/tools/index.mjs");
const builtStorage = await importBuiltModule<typeof storageType>(
  "../../dist/extension/lib/storage/index.mjs",
);
const builtVercel = await importBuiltModule<typeof vercelStorageType>(
  "../../dist/extension/lib/storage/vercel-blob.mjs",
);
const builtCore = await importBuiltModule<typeof coreType>("../../dist/extension/lib/core.mjs");

afterEach(() => {
  builtIndex.video({});
});

describe("@eve/video built package artifacts and entry points", () => {
  test("ships compatibility manifest, instructions, and NOTICE on disk", async () => {
    const manifestRaw = await readFile(
      new URL("../../dist/extension/_manifest.json", import.meta.url),
      "utf8",
    );
    const manifest = JSON.parse(manifestRaw) as {
      readonly kind?: string;
      readonly formatVersion?: number;
      readonly builtWithEve?: string;
    };
    assert.equal(manifest.kind, "eve-extension");
    assert.equal(typeof manifest.formatVersion, "number");
    assert.equal(typeof manifest.builtWithEve, "string");

    const instructions = await readFile(
      new URL("../../dist/extension/instructions.md", import.meta.url),
      "utf8",
    );
    assert.match(instructions, /video `generate` tool/);

    const notice = await readFile(join(PACKAGE_ROOT, "NOTICE"), "utf8");
    assert.match(notice, /Vercel/);
  });

  test("validates config synchronously at mount time and rejects malformed storage or model", () => {
    assert.equal(builtIndex.default, builtIndex.video);
    assert.throws(
      () => builtIndex.video({ storage: {} as never }),
      /Invalid extension config: storage:/,
    );
    assert.throws(
      () =>
        builtIndex.video({
          model: { specificationVersion: "v4", provider: "p", modelId: "m" } as never,
        }),
      /Invalid extension config: model:/,
    );
    assert.throws(
      () => builtIndex.video({ poll: { timeoutMs: 50 } }),
      /Invalid extension config: poll\.timeoutMs:/,
    );
  });

  test("executes built generate tool, storage adapters, core workflow helpers, and webhook verification from dist/", async () => {
    const storage = builtStorage.inMemory({ baseUrl: "https://built.example.test/media" });
    const fake = createAsyncVideoModel({
      modelId: "test/built-entry-model",
      jobId: "job_built_1",
      statuses: [
        {
          status: "completed",
          videos: [{ type: "binary", data: MP4_BYTES, mediaType: "video/mp4" }],
        },
      ],
    });

    const mounted = builtIndex.video({
      model: fake.model,
      storage,
      poll: { intervalMs: 0 },
    });
    assert.equal(Reflect.get(mounted, Symbol.for("eve.mounted-extension")), true);

    const { progress, output } = await executeGenerateTool(builtTools.generate, {
      prompt: "Built dist entry execution",
    });

    assert.deepEqual(
      progress.map((p) => p.status),
      ["starting", "generating", "saving"],
    );
    assert.equal(output.status, "completed");
    assert.equal(output.model, "test/built-entry-model");
    assert.equal(output.jobId, "job_built_1");
    assert.ok(output.videos[0].url?.startsWith("https://built.example.test/media/videos/"));

    const saved = await storage.get({
      key: output.videos[0].storageKey as string,
      signal: new AbortController().signal,
    });
    assert.deepEqual(saved?.data, MP4_BYTES);

    const diskRoot = await mkdtemp(join(tmpdir(), "eve-video-built-disk-"));
    try {
      const disk = builtStorage.localDisk({ directory: diskRoot });
      await disk.put({
        key: "built.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "built.mp4",
        signal: new AbortController().signal,
      });
      const fromDisk = await disk.get?.({
        key: "built.mp4",
        signal: new AbortController().signal,
      });
      assert.deepEqual(fromDisk?.data, MP4_BYTES);
    } finally {
      await rm(diskRoot, { recursive: true, force: true });
    }

    assert.throws(() => builtVercel.vercelBlob({ prefix: "   " }), TypeError);

    const handle = await builtCore.startVideoJob({
      config: { model: fake.model },
      input: { prompt: "Built workflow primitive" },
    });
    assert.equal(handle.modelId, "test/built-entry-model");

    const now = 1_700_000_000;
    const rawBody = '{"event":"video.completed"}';
    const digest = createHmac("sha256", "whsec_built").update(`${now}.${rawBody}`).digest("hex");
    assert.equal(
      builtCore.verifyGatewayWebhookSignature({
        header: `t=${now},v1=${digest}`,
        rawBody,
        secret: "whsec_built",
        nowSeconds: now,
      }),
      true,
    );
  });
});
