import { docker } from "eve/sandbox/docker";
import { justbash } from "eve/sandbox/just-bash";
import { microsandbox } from "eve/sandbox/microsandbox";
import { vercel } from "eve/sandbox/vercel";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelfModificationConfig } from "./config.js";
import { defineSelfModificationSandbox, selectDeployedSelfModificationBackend } from "./sandbox.js";

const connectConfig: SelfModificationConfig = {
  deployed: {
    credentials: { vercelConnect: { connector: "github/selfmod-acme-agent" } },
    source: { git: { directory: ".", repository: "github.com/acme/agent" } },
    target: { branch: "main" },
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("self-modification sandbox", () => {
  it("selects Vercel Sandbox for an unspecified backend on Vercel", () => {
    expect(
      selectDeployedSelfModificationBackend(undefined, {
        isDeployedOnVercel: () => true,
        isMicrosandboxSupported: () => true,
      }).name,
    ).toBe("vercel");
  });

  it("selects microsandbox for an unspecified backend on a supported self-hosted system", () => {
    expect(
      selectDeployedSelfModificationBackend(undefined, {
        isDeployedOnVercel: () => false,
        isMicrosandboxSupported: () => true,
      }).name,
    ).toBe("microsandbox");
  });

  it.each([
    ["docker", docker()],
    ["just-bash", justbash()],
  ] as const)("rejects the %s backend for deployed self-modification", (name, backend) => {
    expect(() =>
      selectDeployedSelfModificationBackend(backend, {
        isDeployedOnVercel: () => true,
        isMicrosandboxSupported: () => true,
      }),
    ).toThrow(
      `Deployed self-modification requires runtime credential transforms. The configured ${name} backend does not support them. Use vercel() on Vercel or microsandbox() on a supported self-hosted system.`,
    );
  });

  it("reports the same backend guidance when automatic selection cannot find one", () => {
    expect(() =>
      selectDeployedSelfModificationBackend(undefined, {
        isDeployedOnVercel: () => false,
        isMicrosandboxSupported: () => false,
      }),
    ).toThrow(
      "Deployed self-modification requires runtime credential transforms. No supported backend is available. Use vercel() on Vercel or microsandbox() on a supported self-hosted system.",
    );
  });

  it.each([microsandbox(), vercel()])(
    "accepts an explicitly configured $name backend",
    (backend) => {
      expect(
        selectDeployedSelfModificationBackend(backend, {
          isDeployedOnVercel: () => false,
          isMicrosandboxSupported: () => false,
        }),
      ).toBe(backend);
    },
  );

  it("does not update the just-bash network policy in local mode", async () => {
    vi.stubEnv("EVE_DEV", "1");
    const definition = defineSelfModificationSandbox({ config: connectConfig });
    if (definition.onSession === undefined) throw new Error("Expected an onSession hook.");
    const use = vi.fn();

    await definition.onSession({
      ctx: { session: { parent: undefined } } as never,
      use,
    });

    expect(use).not.toHaveBeenCalled();
  });

  it("establishes its allow-all baseline before resolving deployed credentials", async () => {
    vi.stubEnv("EVE_DEV", "0");
    vi.stubEnv("VERCEL_ENV", "production");
    const definition = defineSelfModificationSandbox({ config: connectConfig });
    if (definition.onSession === undefined) throw new Error("Expected an onSession hook.");
    const failure = new Error("baseline applied");
    const setNetworkPolicy = vi.fn().mockRejectedValue(failure);

    await expect(
      definition.onSession({
        ctx: { session: { parent: {} } } as never,
        use: async () => ({ setNetworkPolicy }) as never,
      }),
    ).rejects.toBe(failure);
    expect(setNetworkPolicy).toHaveBeenCalledWith("allow-all");
  });
});
