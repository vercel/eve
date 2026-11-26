import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, test } from "node:test";

import type { WorkflowTaskToolDefinition } from "eve/tools";

import type extensionType from "../../extension/extension.ts";
import type * as coreType from "../../extension/lib/core.ts";
import type * as storageType from "../../extension/lib/storage/index.ts";
import type * as vercelStorageType from "../../extension/lib/storage/vercel-blob.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
} from "../../extension/lib/types.ts";

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

    const generateDts = await readFile(
      new URL("../../dist/extension/tools/generate.d.ts", import.meta.url),
      "utf8",
    );
    assert.match(generateDts, /\bWorkflowTaskToolDefinition\b/);
  });

  test("resolves all five dist/ entry points, exposes public exports, and validates config at mount time", () => {
    assert.equal(builtIndex.default, builtIndex.video);
    const mounted = builtIndex.video({
      storage: builtStorage.inMemory(),
      poll: { intervalMs: 100 },
    });
    assert.equal(Reflect.get(mounted, Symbol.for("eve.mounted-extension")), true);

    assert.equal(typeof builtTools.generate.task, "function");
    assert.equal(typeof builtTools.generate.toModelOutput, "function");
    assert.equal(typeof builtTools.generate.label, "object");
    assert.equal(typeof builtTools.generate.approval, "object");

    assert.equal(typeof builtStorage.inMemory, "function");
    assert.equal(typeof builtStorage.localDisk, "function");

    assert.equal(typeof builtVercel.vercelBlob, "function");
    assert.throws(() => builtVercel.vercelBlob({ prefix: "   " }), TypeError);

    assert.equal(builtCore.DEFAULT_VIDEO_MODEL, "google/veo-3.1-fast-generate-001");
    assert.equal(typeof builtCore.startVideoJob, "function");
    assert.equal(typeof builtCore.checkVideoJob, "function");
    assert.equal(typeof builtCore.persistVideos, "function");
    assert.equal(typeof builtCore.verifyGatewayWebhookSignature, "function");

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
    assert.throws(
      () => builtIndex.video({ poll: { timeoutMs: 50 } }),
      /Invalid extension config: poll\.timeoutMs:/,
    );
    assert.throws(
      () => builtIndex.video({ webhook: "always" as never }),
      /Invalid extension config: webhook:/,
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
