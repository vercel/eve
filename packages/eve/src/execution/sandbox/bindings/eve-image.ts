import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const EVE_SANDBOX_IMAGE_REPOSITORY = "vcr.vercel.com/vercel/eve/base";

export function resolveEveSandboxImage(): string {
  return `${EVE_SANDBOX_IMAGE_REPOSITORY}:${resolveInstalledPackageInfo().version}`;
}

export const DEFAULT_EVE_SANDBOX_IMAGE = resolveEveSandboxImage();
