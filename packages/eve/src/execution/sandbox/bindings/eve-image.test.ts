import { describe, expect, it, vi } from "vitest";

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
  it("uses the versioned GHCR image outside Vercel Sandbox", () => {
    expect(resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:1.2.3");
    expect(DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:1.2.3");
  });

  it("uses the versioned VCR image for Vercel Sandbox", () => {
    expect(resolveVercelEveSandboxImage()).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
    expect(VERCEL_EVE_SANDBOX_IMAGE).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
  });
});
