import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", () => ({
  readFile: async (path: string) => {
    const value = files.get(path);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  },
}));

beforeEach(() => files.clear());

it.each([
  [
    "old",
    {
      runtimeAppRoot: "/old",
      recoveryVersion: 1,
      frameworkFingerprint: "older build",
      workflowSourceFingerprint: "older workflow",
    },
    "ready",
  ],
  ["legacy", { runtimeAppRoot: "/old" }, "ineligible"],
  ["invalid-version", { runtimeAppRoot: "/old", recoveryVersion: 2 }, "ineligible"],
  ["invalid-schema", { runtimeAppRoot: 42, recoveryVersion: 1 }, "ineligible"],
] as const)("reads %s recovery metadata", async (generationId, metadata, kind) => {
  files.set(
    `/app/.eve/dev-runtime/snapshots/${generationId}/generation.json`,
    JSON.stringify(metadata),
  );
  const { readDevelopmentGenerationAvailability } =
    await import("./development-runtime-compatibility.js");
  await expect(readDevelopmentGenerationAvailability("/app", generationId)).resolves.toMatchObject({
    kind,
  });
});

it("distinguishes a missing snapshot from malformed metadata", async () => {
  const { readDevelopmentGenerationAvailability } =
    await import("./development-runtime-compatibility.js");
  await expect(readDevelopmentGenerationAvailability("/app", "missing")).resolves.toMatchObject({
    kind: "missing",
  });
  files.set("/app/.eve/dev-runtime/snapshots/bad/generation.json", "{");
  await expect(readDevelopmentGenerationAvailability("/app", "bad")).resolves.toMatchObject({
    kind: "ineligible",
  });
});
