import { afterEach, describe, expect, it, vi } from "vitest";

import { hasCapability, hostCapabilities } from "#platform/capabilities.js";
import type { PlatformContext } from "#platform/context.js";
import { createVercelPlatformContext } from "#platform/vercel/context.js";

const hostWith = (capabilities: unknown) => ({ capabilities }) as PlatformContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hostCapabilities", () => {
  it("answers only what a host declared", () => {
    const host = hostWith(hostCapabilities("1", { hostedSandbox: true }));

    expect(hasCapability(host, "hostedSandbox")).toBe(true);
    expect(hasCapability(host, "agentRuns")).toBe(false);
  });

  it("refuses a version this eve doesn't support", () => {
    expect(() => hostCapabilities("2" as "1")).toThrow('version "2" isn\'t supported');
  });

  it("refuses credential transforms without a hosted sandbox to run them in", () => {
    expect(() => hostCapabilities("1", { sandboxCredentialTransforms: true })).toThrow(
      "only together with hostedSandbox",
    );
  });

  it("refuses capabilities a host wrote by hand", () => {
    const host = hostWith({ hostedSandbox: true });

    expect(() => hasCapability(host, "hostedSandbox")).toThrow(
      "weren't built with hostCapabilities()",
    );
  });

  it("can't be changed after a host declares them", () => {
    const capabilities = hostCapabilities("1", {});

    expect(Object.isFrozen(capabilities)).toBe(true);
  });
});

describe("the Vercel platform's capabilities", () => {
  it("follow whether eve is running on Vercel each time they're read", () => {
    const platform = createVercelPlatformContext();

    vi.stubEnv("VERCEL", "1");
    expect(hasCapability(platform, "hostedSandbox")).toBe(true);
    expect(hasCapability(platform, "sandboxCredentialTransforms")).toBe(true);
    expect(hasCapability(platform, "stopsSandboxesOnExit")).toBe(true);

    vi.stubEnv("VERCEL", "");
    expect(hasCapability(platform, "hostedSandbox")).toBe(false);
    expect(hasCapability(platform, "stopsSandboxesOnExit")).toBe(false);
    expect(hasCapability(platform, "agentRuns")).toBe(true);
  });
});
