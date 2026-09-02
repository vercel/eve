import { describe, expect, it, vi } from "vitest";

vi.mock("#internal/application/package.js", () => ({
  resolveInstalledPackageInfo: () => ({ version: "1.2.3" }),
}));

import {
  DEFAULT_EVE_SANDBOX_IMAGE,
  resolveEveSandboxImage,
} from "#execution/sandbox/bindings/eve-image.js";

describe("eve sandbox image", () => {
  it("keeps latest as the temporary default", () => {
    expect(DEFAULT_EVE_SANDBOX_IMAGE).toBe("ghcr.io/vercel/eve:latest");
  });

  it("resolves a GHCR tag matching the installed eve version", () => {
    expect(resolveEveSandboxImage()).toBe("ghcr.io/vercel/eve:1.2.3");
  });
});
