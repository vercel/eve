import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBoundSandboxEnvironment,
  getSandboxEnvironmentRuntime,
  type SandboxSelectorContext,
} from "#shared/sandbox-environment.js";
import { createSandboxPrepareContext } from "#execution/sandbox/prewarm.js";

import type { DeployedSelfModificationConfig } from "./remote/config.js";
import { defineDeployedSelfModificationSandbox } from "./deployed-sandbox.js";

const connectConfig: DeployedSelfModificationConfig = {
  authorize: () => true,
  credentials: { pat: true },
  source: { git: { directory: ".", repository: "github.com/acme/agent" } },
  target: { branch: "main" },
};

afterEach(() => vi.unstubAllEnvs());

describe("deployed self-modification sandbox", () => {
  it("builds off Vercel without probing the host or preparing a snapshot", async () => {
    vi.stubEnv("EVE_DEV", "0");
    const isDeployedOnVercel = vi.fn(() => false);

    const environment = getBoundSandboxEnvironment(
      defineDeployedSelfModificationSandbox(connectConfig, isDeployedOnVercel),
    );

    expect(environment?.provider).toBe("vercel");
    const runtime = getSandboxEnvironmentRuntime(environment!);
    const prepareContext = createSandboxPrepareContext({
      appRoot: "/app",
      files: { list: async () => [], read: vi.fn(), readText: vi.fn() },
      log: () => {},
      provider: runtime,
      resources: {},
      sourceRevision: "revision",
      storagePath: "/app/.eve/sandbox",
    });
    await expect(runtime.implementation.prepare(prepareContext)).resolves.toEqual({});
    expect(isDeployedOnVercel).not.toHaveBeenCalled();
  });

  it("requires a Vercel deployment when a deployed child opens its sandbox", async () => {
    vi.stubEnv("EVE_DEV", "0");
    const selector = defineDeployedSelfModificationSandbox(connectConfig, () => false);

    await expect(
      selector({ session: { id: "child", parent: {} } } as SandboxSelectorContext),
    ).rejects.toThrow("Deployed self-modification requires deploying on Vercel");
  });

  it("does not probe the host during eve dev", () => {
    vi.stubEnv("EVE_DEV", "1");
    const isDeployedOnVercel = vi.fn(() => false);
    expect(defineDeployedSelfModificationSandbox(connectConfig, isDeployedOnVercel)).toBeTypeOf(
      "function",
    );
    expect(isDeployedOnVercel).not.toHaveBeenCalled();
  });
});
