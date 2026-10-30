import { afterEach, describe, expect, it, vi } from "vitest";

async function importImages() {
  vi.resetModules();
  return import("#execution/sandbox/bindings/eve-image.js");
}

describe("eve sandbox image", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins both registries to the same Dockerfile content tag", async () => {
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "");
    const images = await importImages();
    const tag = images.DEFAULT_EVE_SANDBOX_IMAGE.replace("ghcr.io/vercel/eve:", "");

    expect(tag).toMatch(/^dockerfile-[0-9a-f]{12}$/);
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe(`vcr.vercel.com/vercel/eve/base:${tag}`);
  });

  it("uses EVE_SANDBOX_IMAGE_TAG for both registries", async () => {
    vi.stubEnv("EVE_SANDBOX_IMAGE_TAG", "latest");
    const images = await importImages();

    expect(images.DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:latest");
    expect(images.VERCEL_EVE_SANDBOX_IMAGE).toBe("vcr.vercel.com/vercel/eve/base:latest");
  });
});
