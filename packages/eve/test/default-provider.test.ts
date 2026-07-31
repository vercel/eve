import { describe, expect, it } from "vitest";
import {
  selectDefaultSandboxProvider,
  type DefaultSandboxProbes,
} from "../src/execution/sandbox/default-provider.js";

function probes(overrides: Partial<DefaultSandboxProbes>): DefaultSandboxProbes {
  return {
    isDeployedOnVercel: () => false,
    isDockerAvailable: () => false,
    isMicrosandboxSupported: () => false,
    ...overrides,
  };
}

describe("selectDefaultSandboxProvider", () => {
  it("prefers Vercel Sandbox when deploying on Vercel, before any local probe", () => {
    let probed = false;
    const provider = selectDefaultSandboxProvider(
      probes({
        isDeployedOnVercel: () => true,
        isDockerAvailable: () => {
          probed = true;
          return true;
        },
      }),
    );
    expect(provider).toBe("vercel");
    expect(probed).toBe(false);
  });

  it("picks docker when a daemon is available", () => {
    const provider = selectDefaultSandboxProvider(
      probes({ isDockerAvailable: () => true, isMicrosandboxSupported: () => true }),
    );
    expect(provider).toBe("docker");
  });

  it("falls back to microsandbox on supported hosts without docker", () => {
    const provider = selectDefaultSandboxProvider(probes({ isMicrosandboxSupported: () => true }));
    expect(provider).toBe("microsandbox");
  });

  it("falls back to just-bash when nothing else is available", () => {
    const provider = selectDefaultSandboxProvider(probes({}));
    expect(provider).toBe("just-bash");
  });
});
