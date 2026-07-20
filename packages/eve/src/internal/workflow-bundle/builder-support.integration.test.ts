import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";

import { bundleFinalWorkflowOutput } from "./builder-support.js";

describe("bundleFinalWorkflowOutput", () => {
  it("writes the intermediate wrapper against the namespaced eve Workflow runtime facade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-workflow-runtime-facade-"));
    const target = join(dir, "workflows.mjs");

    try {
      await bundleFinalWorkflowOutput({
        bundleFinalOutput: false,
        code: "globalThis.__private_workflows = new Map();",
        format: "esm",
        outfile: target,
        queueNamespace: "evetest",
        workingDir: resolvePackageRoot(),
      });

      const source = await readFile(target, "utf8");
      const runtimePath = resolveWorkflowModulePath("workflow/runtime").replaceAll("\\", "/");
      expect(source).toContain(`from ${JSON.stringify(runtimePath)}`);
      expect(source).toContain('workflowEntrypoint(workflowCode, { namespace: "evetest" })');
      expect(source).not.toContain('from "workflow/runtime"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
