import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadMicrosandboxWithoutInstall } from "#execution/sandbox/bindings/microsandbox-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("loadMicrosandboxWithoutInstall", () => {
  it("loads the microsandbox version installed in the application", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-microsandbox-cleanup-"));
    temporaryDirectories.push(appRoot);
    const packageRoot = join(appRoot, "node_modules", "microsandbox");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ exports: "./index.js", type: "module" }),
    );
    await writeFile(
      join(packageRoot, "index.js"),
      [
        'export const cleanupSource = "application";',
        "export function isInstalled() { return true; }",
      ].join("\n"),
    );

    const module = await loadMicrosandboxWithoutInstall(appRoot);

    expect((module as unknown as { cleanupSource: string }).cleanupSource).toBe("application");
  });
});
