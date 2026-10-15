import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createExternalDependencyOutputCheckPlugin } from "#internal/nitro/host/external-dependency-output-check-plugin.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createDirectory = useTemporaryDirectories();

async function writePackage(root: string): Promise<void> {
  await mkdir(join(root, "node_modules", "pg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pg", "package.json"), '{"name":"pg"}\n');
}

async function checkOutput(input: { readonly installAt: "server" | "above" | "nowhere" }) {
  const root = await createDirectory("eve-external-output-check-");
  const serverDir = join(root, "server");
  await mkdir(join(serverDir, "_chunks"), { recursive: true });
  if (input.installAt === "server") await writePackage(serverDir);
  if (input.installAt === "above") await writePackage(root);

  const plugin = createExternalDependencyOutputCheckPlugin({
    appRoot: "/app",
    externalDependencies: ["pg"],
  });
  plugin?.writeBundle(
    { dir: serverDir },
    {
      "_chunks/db.mjs": { fileName: "_chunks/db.mjs", imports: ["pg/lib/client"], type: "chunk" },
      "index.mjs": {
        dynamicImports: ["pg"],
        fileName: "index.mjs",
        imports: ["_chunks/db.mjs", "zod"],
        type: "chunk",
      },
    },
  );
}

describe("external dependency output check", () => {
  it("accepts a configured external the output contains", async () => {
    await expect(checkOutput({ installAt: "server" })).resolves.toBeUndefined();
  });

  it("rejects a configured external the output does not contain", async () => {
    await expect(checkOutput({ installAt: "nowhere" })).rejects.toThrow(
      '"pg" is listed in build.externalDependencies and imported by the hosted bundle (_chunks/db.mjs), but the build output does not contain it. Add "pg" to the dependencies in /app/package.json.',
    );
  });

  it("rejects a package that only resolves from above the output", async () => {
    await expect(checkOutput({ installAt: "above" })).rejects.toThrow('"pg" is listed');
  });

  it("does nothing when no externals are configured", () => {
    expect(
      createExternalDependencyOutputCheckPlugin({ appRoot: "/app", externalDependencies: [] }),
    ).toBeNull();
  });
});
