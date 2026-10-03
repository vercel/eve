import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeployedSelfModificationConfig } from "./deployed/config.js";
import {
  defineDeployedSelfModificationSandbox,
  selectDeployedSelfModificationEnvironment,
} from "./deployed-sandbox.js";

const connectConfig: DeployedSelfModificationConfig = {
  authorize: () => true,
  credentials: { pat: true },
  source: { git: { directory: ".", repository: "github.com/acme/agent" } },
  target: { branch: "main" },
};

afterEach(() => vi.unstubAllEnvs());

describe("deployed self-modification sandbox", () => {
  it("selects Vercel Sandbox on Vercel", () => {
    expect(
      selectDeployedSelfModificationEnvironment({
        isDeployedOnVercel: () => true,
        isMicrosandboxSupported: () => true,
      }).provider,
    ).toBe("vercel");
  });

  it("selects microsandbox on a supported self-hosted system", () => {
    expect(
      selectDeployedSelfModificationEnvironment({
        isDeployedOnVercel: () => false,
        isMicrosandboxSupported: () => true,
      }).provider,
    ).toBe("microsandbox");
  });

  it("fails when no deployed provider is available", () => {
    expect(() =>
      selectDeployedSelfModificationEnvironment({
        isDeployedOnVercel: () => false,
        isMicrosandboxSupported: () => false,
      }),
    ).toThrow("No supported provider is available");
  });

  it("does not probe deployed providers during eve dev", () => {
    vi.stubEnv("EVE_DEV", "1");
    const probes = { isDeployedOnVercel: vi.fn(), isMicrosandboxSupported: vi.fn() };
    expect(defineDeployedSelfModificationSandbox(connectConfig, probes)).toBeTypeOf("function");
    expect(probes.isDeployedOnVercel).not.toHaveBeenCalled();
    expect(probes.isMicrosandboxSupported).not.toHaveBeenCalled();
  });
});
