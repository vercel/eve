import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { importOptionalEnginePackage } from "#internal/application/optional-package-import.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

describe("importOptionalEnginePackage", () => {
  it("falls back to the application's install when eve cannot resolve the package", async () => {
    const appRoot = await createScratchDirectory("eve-optional-import-");
    const packageRoot = join(appRoot, "node_modules", "optional-engine");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ exports: "./index.js", type: "module" }),
    );
    await writeFile(join(packageRoot, "index.js"), 'export const engine = "from the app";\n');
    const load = (root: string) =>
      importOptionalEnginePackage<{ engine: string }>({
        appRoot: root,
        importModule: async () => {
          throw new Error("Cannot find package 'optional-engine'");
        },
        missingMessage: "Install optional-engine.",
        packageName: "optional-engine",
      });

    await expect(load(appRoot)).resolves.toMatchObject({ engine: "from the app" });
    await expect(load(await createScratchDirectory("eve-optional-missing-"))).rejects.toThrow(
      "Install optional-engine.",
    );
  });
});
