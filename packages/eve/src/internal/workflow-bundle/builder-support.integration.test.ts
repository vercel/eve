import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import {
  resolvePackageRoot,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { buildSingleRolldownChunk } from "#internal/bundler/nitro-rolldown.js";

import {
  bundleFinalWorkflowOutput,
  createEvePackageImportsPlugin,
  createWorkflowNodeBuiltinGuardPlugin,
} from "./builder-support.js";

it("bundles code mode approval state without Node-only request handlers", async () => {
  const packageRoot = resolvePackageRoot();
  const chunk = await buildSingleRolldownChunk("code mode state", {
    cwd: packageRoot,
    input: resolvePackageSourceFilePath("src/execution/code-mode/state.ts"),
    platform: "neutral",
    plugins: [
      createEvePackageImportsPlugin(packageRoot, { workflowCondition: true }),
      createWorkflowNodeBuiltinGuardPlugin(),
    ],
    resolve: { conditionNames: ["eve-source", "workflow"] },
    tsconfig: join(packageRoot, "tsconfig.json"),
    output: { format: "esm" },
  });
  expect(chunk.code).toContain("adoptCodeModeStateChanges");
  expect(chunk.code).toContain("eve.runtime.hitl.approvedTools");
});

describe("bundleFinalWorkflowOutput", () => {
  it("writes the final wrapper with encoded code and resolved runtime imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-workflow-runtime-facade-"));
    const target = join(dir, "workflows.mjs");
    const workflowCode = [
      "globalThis.__private_workflows = new Map();",
      "//# sourceMappingURL=data:application/json;base64,ZmFrZQ==",
    ].join("\n");

    try {
      await bundleFinalWorkflowOutput({
        code: workflowCode,
        outfile: target,
        queueNamespace: "evetest",
        stepRegistrationsPath: join(dir, "steps.mjs"),
      });

      const source = await readFile(target, "utf8");
      const runtimeSpecifier = normalizeEsmImportSpecifier(
        resolveWorkflowModulePath("workflow/runtime"),
      );
      expect(source).toContain(`from ${JSON.stringify(runtimeSpecifier)}`);
      expect(source).toContain('Buffer.from(["');
      expect(source).not.toContain("const workflowCode = `");
      expect(source).toContain('workflowEntrypoint(workflowCode, { namespace: "evetest" })');
      expect(source).toContain(
        'import { __steps_registered as __eveWorkflowStepsRegistered } from "./steps.mjs";',
      );
      expect(source).toContain("void __eveWorkflowStepsRegistered;");
      expect(source).not.toContain('from "workflow/runtime"');

      const encodedChunksMatch = source.match(
        /Buffer\.from\((\[[\s\S]*?\])\.join\(""\), "base64"\)\.toString\("utf8"\)/,
      );
      const encodedChunks = JSON.parse(encodedChunksMatch?.[1] ?? "[]") as string[];
      expect(Buffer.from(encodedChunks.join(""), "base64").toString("utf8")).toBe(
        `${workflowCode}\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
