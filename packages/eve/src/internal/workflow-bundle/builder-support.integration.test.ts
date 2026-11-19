import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeEsmImportSpecifier } from "#internal/application/import-specifier.js";
import { resolveWorkflowModulePath } from "#internal/application/package.js";

import { bundleFinalWorkflowOutput } from "./builder-support.js";

describe("bundleFinalWorkflowOutput", () => {
  it("writes the driver code as a text asset beside a wrapper with resolved runtime imports", async () => {
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
      const codePath = join(dir, "workflows.code.txt");
      expect(source).toContain(`from ${JSON.stringify(runtimeSpecifier)}`);
      expect(source).toContain(
        `import workflowCode from ${JSON.stringify(`text:${codePath.replaceAll("\\", "/")}`)};`,
      );
      expect(source).not.toContain("globalThis.__private_workflows");
      expect(source).toContain('workflowEntrypoint(workflowCode, { namespace: "evetest" })');
      expect(source).toContain(
        'import { __steps_registered as __eveWorkflowStepsRegistered } from "./steps.mjs";',
      );
      expect(source).toContain("void __eveWorkflowStepsRegistered;");
      expect(source).not.toContain('from "workflow/runtime"');
      expect(await readFile(codePath, "utf8")).toBe(`${workflowCode}\n`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
