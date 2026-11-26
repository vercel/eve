import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";

import type { WorkflowTaskToolDefinition } from "eve/tools";
import { always, type ApprovalConfiguration } from "eve/tools/approval";

import type extensionType from "../../extension/extension.ts";
import type * as coreType from "../../extension/lib/core.ts";
import type * as storageType from "../../extension/lib/storage/index.ts";
import type * as vercelStorageType from "../../extension/lib/storage/vercel-blob.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
} from "../../extension/lib/types.ts";
import { MP4_BYTES, createAsyncVideoModel, createFakeApprovalContext } from "../helpers.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const EVE_PACKAGE_ROOT = dirname(requireFromTest.resolve("eve/package.json"));
const EVE_CLI_BIN = join(EVE_PACKAGE_ROOT, "bin", "eve.js");

interface BuiltIndexModule {
  readonly default: typeof extensionType;
  readonly video: typeof extensionType;
}

interface BuiltToolsModule {
  readonly generate: WorkflowTaskToolDefinition<
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
  test("ships compatibility manifest, instructions, NOTICE, and workflow directives on disk", async () => {
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

    const generateSource = await readFile(
      new URL("../../dist/extension/tools/generate.mjs", import.meta.url),
      "utf8",
    );
    assert.match(generateSource, /["']use workflow["']/);
    assert.match(generateSource, /\bdefineWorkflowTool\b/);
    assert.match(generateSource, /from\s+["']eve\/workflow["']/);

    const stepsSource = await readFile(
      new URL("../../dist/extension/lib/workflow-steps.mjs", import.meta.url),
      "utf8",
    );
    for (const helperName of [
      "submitVideoStep",
      "verifyAndRespondWebhookStep",
      "checkAndPersistStep",
      "cleanupStagedInputsStep",
    ]) {
      const fnIndex = stepsSource.indexOf(`function ${helperName}`);
      assert.ok(fnIndex >= 0, `Expected ${helperName} in dist/extension/lib/workflow-steps.mjs`);
      const bodyStart = stepsSource.indexOf("{", fnIndex);
      const bodySlice = stepsSource.slice(bodyStart, bodyStart + 80);
      assert.match(bodySlice, /["']use step["']/, `Expected "use step" directive in ${helperName}`);
    }

    const generateDts = await readFile(
      new URL("../../dist/extension/tools/generate.d.ts", import.meta.url),
      "utf8",
    );
    assert.match(generateDts, /\bWorkflowTaskToolDefinition\b/);
  });

  test("validates config synchronously at mount time and rejects malformed storage, model, poll, or webhook", () => {
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
      () => builtIndex.video({ poll: { intervalMs: 0 } }),
      /Invalid extension config: poll\.intervalMs:/,
    );
    assert.doesNotThrow(() => builtIndex.video({ poll: { intervalMs: 100 } }));
    assert.throws(
      () => builtIndex.video({ poll: { timeoutMs: 50 } }),
      /Invalid extension config: poll\.timeoutMs:/,
    );
    assert.throws(
      () => builtIndex.video({ webhook: "always" as never }),
      /Invalid extension config: webhook:/,
    );
  });

  test("exposes mounted workflow tool surface, storage adapters, core helpers, and webhook verification from dist/", async () => {
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

    const input: GenerateVideoToolInput = {
      prompt: "Built dist entry execution",
      duration: 4,
      aspectRatio: "16:9",
    };

    const mounted = builtIndex.video({
      model: fake.model,
      storage,
      poll: { intervalMs: 100 },
      approval: always(),
    });
    assert.equal(Reflect.get(mounted, Symbol.for("eve.mounted-extension")), true);

    const tool = builtTools.generate;
    assert.equal(typeof tool.task, "function");
    assert.equal(typeof tool.toModelOutput, "function");
    assert.equal(typeof tool.label, "object");
    if (typeof tool.label === "object" && tool.label !== null) {
      assert.equal(tool.label.start(input), "Generating video");
      assert.equal(
        tool.label.delta?.(input, {
          status: "generating",
          model: "test/built-entry-model",
          elapsedSeconds: 5,
          attempt: 1,
        }),
        "Generating video (5s)",
      );
      assert.equal(
        tool.label.complete?.(input, {
          status: "completed",
          model: "test/built-entry-model",
          videos: [{ mediaType: "video/mp4", bytes: MP4_BYTES.byteLength }],
        }),
        "Generated video",
      );
    }

    const sampleOutput: GenerateVideoToolOutput = {
      status: "completed",
      model: "test/built-entry-model",
      jobId: "job_built_1",
      videos: [{ mediaType: "video/mp4", bytes: MP4_BYTES.byteLength }],
    };
    const projected = tool.toModelOutput?.(sampleOutput, {
      callId: "call-built-1",
      toolName: "video__generate",
      async getSandbox() {
        return undefined;
      },
      defaultModelOutput(value) {
        return { type: "json", value };
      },
    });
    assert.deepEqual(projected, { type: "json", value: sampleOutput });

    const approval = tool.approval as ApprovalConfiguration<GenerateVideoToolInput>;
    assert.equal(await approval.request(createFakeApprovalContext(input)), "user-approval");
    assert.equal(
      approval.prompt?.({ callId: "call-built-1", input, toolName: "video__generate" }),
      'Generate video with test/built-entry-model (4s, 16:9): "Built dist entry execution"',
    );

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

    assert.equal(builtCore.DEFAULT_VIDEO_MODEL, "google/veo-3.1-fast-generate-001");
    assert.equal("generateVideos" in builtCore, false);

    const handle = await builtCore.startVideoJob({
      config: { model: fake.model },
      input: { prompt: "Built workflow primitive" },
    });
    assert.equal(handle.modelId, "test/built-entry-model");

    const status = await builtCore.checkVideoJob({
      config: { model: fake.model },
      modelId: handle.modelId,
      operation: handle.operation,
    });
    assert.equal(status.status, "completed");
    if (status.status !== "completed") {
      assert.fail("Expected completed status from builtCore.checkVideoJob.");
    }
    const persisted = await builtCore.persistVideos({
      videos: status.videos,
      modelId: handle.modelId,
      storage,
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].bytes, MP4_BYTES.byteLength);

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

  test("compiles cleanly in a consumer eve build with vercelBlob() storage", async () => {
    const consumerRoot = await mkdtemp(join(PACKAGE_ROOT, ".tmp-test-"));
    try {
      await mkdir(join(consumerRoot, "agent", "extensions"), { recursive: true });
      await mkdir(join(consumerRoot, "node_modules", "@eve"), { recursive: true });
      await symlink(EVE_PACKAGE_ROOT, join(consumerRoot, "node_modules", "eve"), "junction");
      await symlink(PACKAGE_ROOT, join(consumerRoot, "node_modules", "@eve", "video"), "junction");

      await writeFile(
        join(consumerRoot, "package.json"),
        JSON.stringify({
          name: "eve-video-consumer-build-test",
          private: true,
          type: "module",
          dependencies: {
            eve: "*",
            "@eve/video": "*",
          },
        }),
        "utf8",
      );
      await writeFile(
        join(consumerRoot, "agent", "agent.ts"),
        'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
        "utf8",
      );
      await writeFile(
        join(consumerRoot, "agent", "instructions.md"),
        "You are a video assistant.\n",
        "utf8",
      );
      await writeFile(
        join(consumerRoot, "agent", "extensions", "video.ts"),
        [
          'import video from "@eve/video";',
          'import { vercelBlob } from "@eve/video/vercel";',
          "export default video({",
          "  storage: vercelBlob(),",
          '  gateway: { apiKey: process.env.AI_GATEWAY_API_KEY ?? "test-key" },',
          "});",
          "",
        ].join("\n"),
        "utf8",
      );

      await execFileAsync(process.execPath, [EVE_CLI_BIN, "build", "--skip-sandbox-prewarm"], {
        cwd: consumerRoot,
      });

      const entryStat = await stat(join(consumerRoot, ".output", "server", "index.mjs"));
      assert.equal(entryStat.isFile(), true);
      assert.ok(entryStat.size > 0);
    } finally {
      await rm(consumerRoot, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
