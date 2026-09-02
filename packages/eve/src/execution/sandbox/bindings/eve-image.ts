import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const EVE_SANDBOX_IMAGE_REPOSITORY = "vcr.vercel.com/vercel/eve/base";

// TODO: Replace with resolveEveSandboxImage() after the release workflow publishes its first VCR image.
export const DEFAULT_EVE_SANDBOX_IMAGE = "ghcr.io/vercel/eve:latest";

export function resolveEveSandboxImage(): string {
  return `${EVE_SANDBOX_IMAGE_REPOSITORY}:${resolveInstalledPackageInfo().version}`;
}
