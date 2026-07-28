import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadFileUrlModule, resolveFileUrlModule } from "./load-file-url-module.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("loadFileUrlModule", () => {
  it("normalizes file URLs while retaining Vite query metadata", () => {
    expect(resolveFileUrlModule("nitro/app")).toBeUndefined();
    expect(resolveFileUrlModule("file:///tmp/module.mjs?raw#fragment")).toBe(
      "/tmp/module.mjs?raw#fragment",
    );
    expect(resolveFileUrlModule("../chunks/shared.mjs", "file:///tmp/dist/entry.mjs")).toBe(
      "/tmp/chunks/shared.mjs",
    );
  });

  it("leaves non-file module ids to the host plugin pipeline", async () => {
    await expect(loadFileUrlModule("nitro/app")).resolves.toBeUndefined();
  });

  it("loads a file URL as source text", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-nitro-file-url-"));
    temporaryRoots.push(root);
    const modulePath = join(root, "module.mjs");
    await writeFile(modulePath, 'export const marker = "loaded";\n', "utf8");

    await expect(loadFileUrlModule(pathToFileURL(modulePath).href)).resolves.toBe(
      'export const marker = "loaded";\n',
    );
  });

  it("resolves a package import from a file URL importer", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-nitro-file-url-package-"));
    temporaryRoots.push(root);
    const packageRoot = join(root, "node_modules", "fixture-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ exports: "./index.mjs", name: "fixture-package", type: "module" })}\n`,
      "utf8",
    );
    await writeFile(join(packageRoot, "index.mjs"), "export default true;\n", "utf8");

    expect(
      resolveFileUrlModule("fixture-package", pathToFileURL(join(root, "entry.mjs")).href),
    ).toMatch(/\/node_modules\/fixture-package\/index\.mjs$/);
  });

  it("resolves a package imports alias from a file URL importer", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-nitro-file-url-imports-"));
    temporaryRoots.push(root);
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ imports: { "#fixture": "./mapped.mjs" }, type: "module" })}\n`,
      "utf8",
    );
    await writeFile(join(root, "mapped.mjs"), "export default true;\n", "utf8");

    expect(resolveFileUrlModule("#fixture", pathToFileURL(join(root, "entry.mjs")).href)).toMatch(
      /\/eve-nitro-file-url-imports-[^/]+\/mapped\.mjs$/,
    );
  });
});
