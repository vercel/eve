import { describe, expect, it, vi } from "vitest";

const packageMocks = vi.hoisted(() => ({
  resolveInstalledPackageInfo: vi.fn(() => ({ name: "eve", version: "1.2.3" })),
}));

vi.mock("#internal/application/package.js", () => packageMocks);

import {
  DEFAULT_EVE_SANDBOX_IMAGE,
  resolveEveSandboxImage,
} from "#execution/sandbox/bindings/eve-image.js";

describe("eve sandbox image", () => {
  it("uses the VCR image tagged with the installed eve version", () => {
    expect(resolveEveSandboxImage()).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
    expect(DEFAULT_EVE_SANDBOX_IMAGE).toBe("vcr.vercel.com/vercel/eve/base:1.2.3");
  });
});
