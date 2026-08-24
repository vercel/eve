import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";

const runFile = promisify(execFile);

describe("packed framework source revision", () => {
  const scenarioApp = useScenarioApp();

  it("uses the revision stamped into the package build without source files", async () => {
    const app = await scenarioApp({
      files: {
        "read-revision.mjs": [
          'import { pathToFileURL } from "node:url";',
          "const modulePath = pathToFileURL(`${process.cwd()}/node_modules/eve/dist/src/framework-sources/revision.js`);",
          "const revisionModule = await import(modulePath.href);",
          "process.stdout.write(revisionModule.resolveFrameworkAgentSourceRevision({ fresh: true }));",
          "",
        ].join("\n"),
      },
      installDependencies: true,
      name: "packed-framework-revision",
    });

    const packageRoot = join(app.appRoot, "node_modules", "eve");
    await expect(access(join(packageRoot, "src"))).rejects.toThrow();

    const { stdout } = await runFile(process.execPath, ["read-revision.mjs"], {
      cwd: app.appRoot,
    });

    expect(stdout).toMatch(/^eve@[^:]+:[a-f0-9]{64}$/);
  });
});
