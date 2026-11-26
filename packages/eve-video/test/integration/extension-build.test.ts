import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { WorkflowTaskToolDefinition } from "eve/tools";

import type extensionType from "../../extension/extension.ts";
import type * as slackType from "../../extension/lib/slack.ts";
import type * as storageType from "../../extension/lib/storage/index.ts";
import type * as vercelType from "../../extension/lib/storage/vercel-blob.ts";
import type * as T from "../../extension/lib/types.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);
const EVE_ROOT = dirname(createRequire(import.meta.url).resolve("eve/package.json"));
const rf = (rel: string) => readFile(join(ROOT, rel), "utf8");
const imp = <TMod>(rel: string) => import(new URL(rel, import.meta.url).href) as Promise<TMod>;

const distIndex = await imp<{ default: typeof extensionType; video: typeof extensionType }>(
  "../../dist/index.mjs",
);
const distTools = await imp<{
  generate: WorkflowTaskToolDefinition<
    T.GenerateVideoToolInput,
    T.GenerateVideoToolProgress | T.GenerateVideoToolOutput
  >;
}>("../../dist/tools/index.mjs");
const distStorage = await imp<typeof storageType>("../../dist/extension/lib/storage/index.mjs");
const distVercel = await imp<typeof vercelType>("../../dist/extension/lib/storage/vercel-blob.mjs");
const distSlack = await imp<typeof slackType>("../../dist/extension/lib/slack.mjs");

afterEach(() => {
  distIndex.video({});
});

describe("@eve/video built package and consumer eve build", () => {
  test("ships manifest, instructions, NOTICE, 5 dist entries, and validates mount config", async () => {
    const manifest = JSON.parse(await rf("dist/extension/_manifest.json")) as Record<
      string,
      unknown
    >;
    assert.equal(manifest.kind, "eve-extension");
    assert.equal(typeof manifest.formatVersion, "number");
    assert.equal(typeof manifest.builtWithEve, "string");
    assert.match(await rf("dist/extension/instructions.md"), /video `generate` tool/);
    assert.match(await rf("NOTICE"), /Vercel/);
    assert.match(await rf("dist/extension/tools/generate.mjs"), /["']use workflow["']/);

    assert.equal(distIndex.default, distIndex.video);
    const mounted = distIndex.video({ storage: distStorage.inMemory(), poll: { intervalMs: 100 } });
    assert.equal(Reflect.get(mounted, Symbol.for("eve.mounted-extension")), true);
    assert.equal(typeof distTools.generate.task, "function");
    assert.equal(typeof distStorage.localDisk, "function");
    assert.equal(typeof distVercel.vercelBlob, "function");
    assert.equal(typeof distSlack.slackVideoRenderer, "function");
    assert.equal(typeof distSlack.slackVideoRenderer().events?.["call.settled"], "function");
    assert.throws(() => distVercel.vercelBlob({ prefix: "   " }), TypeError);

    const badConfigs: readonly [Record<string, unknown>, RegExp][] = [
      [{ storage: {} }, /storage:/],
      [{ model: { specificationVersion: "v4", provider: "p", modelId: "m" } }, /model:/],
      [{ poll: { intervalMs: 0 } }, /poll\.intervalMs:/],
      [{ poll: { timeoutMs: 50 } }, /poll\.timeoutMs:/],
      [{ webhook: "always" }, /webhook:/],
    ];
    for (const [cfg, re] of badConfigs) assert.throws(() => distIndex.video(cfg as never), re);
  });

  test("compiles cleanly in a consumer eve build with vercelBlob() storage", async () => {
    const dir = await mkdtemp(join(ROOT, ".tmp-test-"));
    try {
      await mkdir(join(dir, "agent/extensions"), { recursive: true });
      await mkdir(join(dir, "node_modules/@eve"), { recursive: true });
      await symlink(EVE_ROOT, join(dir, "node_modules/eve"), "junction");
      await symlink(ROOT, join(dir, "node_modules/@eve/video"), "junction");
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "consumer",
          private: true,
          type: "module",
          dependencies: { eve: "*", "@eve/video": "*" },
        }),
      );
      await writeFile(
        join(dir, "agent/agent.ts"),
        'import { defineAgent } from "eve";\nexport default defineAgent({ model: "openai/gpt-5.4" });\n',
      );
      await writeFile(join(dir, "agent/instructions.md"), "Video assistant.\n");
      await writeFile(
        join(dir, "agent/extensions/video.ts"),
        'import video from "@eve/video";\nimport { vercelBlob } from "@eve/video/vercel";\nexport default video({ storage: vercelBlob(), gateway: { apiKey: "test-key" } });\n',
      );
      await execFileAsync(
        process.execPath,
        [join(EVE_ROOT, "bin/eve.js"), "build", "--skip-sandbox-prewarm"],
        { cwd: dir },
      );
      const entry = await stat(join(dir, ".output/server/index.mjs"));
      assert.equal(entry.isFile(), true);
      assert.ok(entry.size > 0);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
