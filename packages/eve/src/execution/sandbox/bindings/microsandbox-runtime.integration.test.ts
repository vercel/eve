import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveMicrosandboxOptions } from "#execution/sandbox/bindings/microsandbox-options.js";
import { loadMicrosandboxModule } from "#execution/sandbox/bindings/microsandbox-runtime.js";

vi.mock("#execution/sandbox/bindings/microsandbox-platform.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("#execution/sandbox/bindings/microsandbox-platform.js")
  >()),
  assertMicrosandboxPlatformCandidate: vi.fn(async () => {}),
}));

describe("loadMicrosandboxModule", () => {
  const appRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(appRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  // Regression for #3420: a project that already has microsandbox@^0.7
  // loads a module that exports `isRuntimeInstalled` but not `isInstalled`
  // or `setup`.
  it("rejects an incompatible microsandbox API with the installed version and fix", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "eve-microsandbox-07-"));
    appRoots.push(appRoot);
    const packageRoot = join(appRoot, "node_modules", "microsandbox");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "microsandbox", version: "0.7.0" }),
    );
    const module07 = { isRuntimeInstalled: () => true };

    await expect(
      loadMicrosandboxModule({
        host: {
          loadOptionalPackage: async <T>() => module07 as T,
          resolveProjectPath: (path) => join(appRoot, path),
        },
        options: resolveMicrosandboxOptions({ setup: { autoInstall: false } }),
      }),
    ).rejects.toThrow(/microsandbox@0\.7\.0[\s\S]*pnpm add -D microsandbox@0\.5\.5/u);
  });
});
