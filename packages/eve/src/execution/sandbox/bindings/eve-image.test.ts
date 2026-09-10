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

  it("uses the versioned VCR image for Vercel Sandbox", () => {
    expect(resolveVercelEveSandboxImage()).toBe(
      "vercel/eve/base@sha256:d8d53829d9f05d54a889619603121499e911c467ea22345c28e572a60f613329",
    );
    expect(VERCEL_EVE_SANDBOX_IMAGE).toBe(
      "vercel/eve/base@sha256:d8d53829d9f05d54a889619603121499e911c467ea22345c28e572a60f613329",
    );
  });

  it("uses EVE_SANDBOX_IMAGE_TAG for both registries", async () => {
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "latest");
    vi.resetModules();

    const images = await import("#execution/sandbox/bindings/eve-image.js");
    expect(images.resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:latest");
    expect(images.DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:latest");
    expect(images.resolveVercelEveSandboxImage()).toBe(
      "vercel/eve/base@sha256:d8d53829d9f05d54a889619603121499e911c467ea22345c28e572a60f613329",
    );
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe(
      "vercel/eve/base@sha256:d8d53829d9f05d54a889619603121499e911c467ea22345c28e572a60f613329",
    );
  });
});
