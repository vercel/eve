import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveWorkflowModulePath } from "#internal/application/package.js";

import { bundleFinalWorkflowOutput } from "./builder-support.js";

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
      const runtimePath = resolveWorkflowModulePath("workflow/runtime").replaceAll("\\", "/");
      expect(source).toContain(`from ${JSON.stringify(runtimePath)}`);
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
