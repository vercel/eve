import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));

import { resolveBundledCompilerArtifactsRoot } from "./bundled-compiler-artifacts-root.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mocks.existsSync.mockReset();
});

describe("resolveBundledCompilerArtifactsRoot", () => {
  it("resolves resources relative to a moved node-server entry", () => {
    const originalProcess = process;
    vi.stubGlobal("process", {
      ...originalProcess,
      argv: [originalProcess.argv[0], "/moved/output/server/index.mjs"],
    });
    mocks.existsSync.mockImplementation((path) => path === "/moved/output/.eve/compile");

    expect(
      resolveBundledCompilerArtifactsRoot("file:///moved/output/server/chunks/runtime.mjs"),
    ).toBe("/moved/output/.eve");
  });

  it("honors an explicit resource root for custom host launchers", () => {
    vi.stubEnv("EVE_COMPILER_ARTIFACTS_ROOT", "/deployment/resources/.eve");

    expect(resolveBundledCompilerArtifactsRoot(import.meta.url)).toBe(
      resolve("/deployment/resources/.eve"),
    );
  });
});
