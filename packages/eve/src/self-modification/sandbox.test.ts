import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelfModificationConfig } from "./config.js";
import {
  defineSelfModificationSandbox,
  selectDeployedSelfModificationEnvironment,
} from "./sandbox.js";

const connectConfig: SelfModificationConfig = {
  deployed: {
    authorize: () => true,
    credentials: { pat: true },
    source: { git: { directory: ".", repository: "github.com/acme/agent" } },
    target: { branch: "main" },
  },
};

afterEach(() => vi.unstubAllEnvs());

describe("self-modification sandbox", () => {
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

  it("returns a callback definition", () => {
    vi.stubEnv("VERCEL", "1");
    expect(defineSelfModificationSandbox({ config: connectConfig })).toBeTypeOf("function");
  });
});
