import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  },
  readdir: async (root: string) =>
    [...files.keys()]
      .filter((path) => path.startsWith(`${root}/`))
      .map((path) => ({ isFile: () => true, parentPath: root, name: path.slice(root.length + 1) })),
}));
vi.mock("#internal/application/package.js", () => ({
  resolvePackageRoot: () => "/eve",
  resolvePackageSourceDirectoryPath: () => "/eve/src",
  resolvePackageCompiledFilePath: () => "/eve/compiled",
}));

beforeEach(() => {
  files.clear();
  files.set("/eve/package.json", '{"version":"1"}');
  files.set("/eve/src/execution/step.ts", "original step");
  files.set("/eve/compiled/core.js", "original runtime");
  vi.resetModules();
});

it.each(["/eve/package.json", "/eve/src/execution/step.ts", "/eve/compiled/core.js"])(
  "rejects recovery after %s changes, even when generation files remain",
  async (path) => {
    const original = await import("./development-runtime-compatibility.js");
    const fingerprint = await original.getDevelopmentFrameworkFingerprint();
    files.set(
      "/app/.eve/dev-runtime/snapshots/old/generation.json",
      JSON.stringify({
        runtimeAppRoot: "/old",
        frameworkFingerprint: fingerprint,
      }),
    );
    files.set(path, "changed");
    vi.resetModules();
    const current = await import("./development-runtime-compatibility.js");
    await expect(
      current.readDevelopmentGenerationAvailability("/app", "old", "old"),
    ).resolves.toMatchObject({ kind: "incompatible" });
  },
);

it("does not invalidate retained runs for test-only edits", async () => {
  const original = await import("./development-runtime-compatibility.js");
  const fingerprint = await original.getDevelopmentFrameworkFingerprint();
  files.set(
    "/app/.eve/dev-runtime/snapshots/old/generation.json",
    JSON.stringify({
      runtimeAppRoot: "/old",
      frameworkFingerprint: fingerprint,
    }),
  );
  files.set("/eve/src/execution/step.test.ts", "new test");
  vi.resetModules();
  const current = await import("./development-runtime-compatibility.js");
  await expect(
    current.readDevelopmentGenerationAvailability("/app", "old", "old"),
  ).resolves.toEqual({ kind: "ready", runtimeAppRoot: "/old" });
});
