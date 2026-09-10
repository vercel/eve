import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#internal/application/package.js", () => ({
  resolveInstalledPackageInfo: () => ({ name: "eve", version: "1.2.3" }),
}));

import {
  DEFAULT_EVE_SANDBOX_IMAGE,
  resolveEveSandboxImage,
  resolveVercelEveSandboxImage,
  VERCEL_EVE_SANDBOX_IMAGE,
} from "#execution/sandbox/bindings/eve-image.js";

describe("eve sandbox image", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the versioned GHCR image outside Vercel Sandbox", () => {
    expect(resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:1.2.3");
    expect(DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:1.2.3");
  });

  it("uses the managed universal image for Vercel Sandbox", () => {
    expect(resolveVercelEveSandboxImage()).toBe("vercel/sandbox/universal:latest");
    expect(VERCEL_EVE_SANDBOX_IMAGE).toBe("vercel/sandbox/universal:latest");
  });

  it("uses EVE_SANDBOX_IMAGE_TAG only for the GHCR image", async () => {
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "latest");
    vi.resetModules();

    const images = await import("#execution/sandbox/bindings/eve-image.js");
    expect(images.resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:latest");
    expect(images.DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:latest");
    expect(images.resolveVercelEveSandboxImage()).toBe("vercel/sandbox/universal:latest");
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe("vercel/sandbox/universal:latest");
  });
});
