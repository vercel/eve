import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageInfo = vi.hoisted(() => ({ name: "eve", version: "1.2.3" }));
vi.mock("#internal/application/package.js", () => ({
  resolveInstalledPackageInfo: () => packageInfo,
}));

import {
  DEFAULT_EVE_SANDBOX_IMAGE,
  resolveEveSandboxImage,
  resolveVercelEveSandboxImage,
  VERCEL_EVE_SANDBOX_IMAGE,
} from "#execution/sandbox/bindings/eve-image.js";

describe("eve sandbox image", () => {
  beforeEach(() => {
    packageInfo.version = "1.2.3";
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the versioned GHCR image outside Vercel Sandbox", () => {
    expect(resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:1.2.3");
    expect(DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:1.2.3");
  });

  it("uses the versioned VCR image for Vercel Sandbox", () => {
    expect(resolveVercelEveSandboxImage()).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
    expect(VERCEL_EVE_SANDBOX_IMAGE).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
  });

  it.each([
    ["0.56.0+git.4c27b3e37fa36d84", "0.56.0"],
    ["0.56.0+main.4c27b3e37fa36d84", "0.56.0"],
    ["0.56.0-beta.1+git.4c27b3e37fa36d84", "0.56.0-beta.1"],
  ])("uses the release image for artifact version %s", async (version, tag) => {
    packageInfo.version = version;
    vi.resetModules();
    const images = await import("#execution/sandbox/bindings/eve-image.js");
    expect(images.resolveEveSandboxImage()).toBe(`ghcr.io/vercel/eve:${tag}`);
    expect(images.DEFAULT_EVE_SANDBOX_IMAGE).toBe(`ghcr.io/vercel/eve:${tag}`);
    expect(images.resolveVercelEveSandboxImage()).toBe(`vcr.vercel.com/vercel/eve/base:${tag}`);
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe(`vcr.vercel.com/vercel/eve/base:${tag}`);
  });

  it("uses EVE_SANDBOX_IMAGE_TAG for both registries", async () => {
    packageInfo.version = "0.56.0+git.4c27b3e37fa36d84";
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "latest");
    vi.resetModules();

    const images = await import("#execution/sandbox/bindings/eve-image.js");
    expect(images.resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:latest");
    expect(images.DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:latest");
    expect(images.resolveVercelEveSandboxImage()).toBe("vcr.vercel.com/vercel/eve/base:latest");
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe("vcr.vercel.com/vercel/eve/base:latest");
  });
});
