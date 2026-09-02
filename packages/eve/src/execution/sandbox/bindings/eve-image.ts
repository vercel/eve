import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const GHCR_EVE_SANDBOX_IMAGE_REPOSITORY = "ghcr.io/vercel/eve";
const VERCEL_EVE_SANDBOX_IMAGE_REPOSITORY = "vcr.vercel.com/vercel/eve/base";

export function resolveEveSandboxImage(): string {
  return `${GHCR_EVE_SANDBOX_IMAGE_REPOSITORY}:${resolveEveSandboxImageTag()}`;
}

export function resolveVercelEveSandboxImage(): string {
  return `${VERCEL_EVE_SANDBOX_IMAGE_REPOSITORY}:${resolveEveSandboxImageTag()}`;
}

function resolveEveSandboxImageTag(): string {
  const override = process.env.EVE_SANDBOX_IMAGE_TAG?.trim();
  return override !== undefined && override.length > 0
    ? override
    : resolveInstalledPackageInfo().version;
}

export const DEFAULT_EVE_SANDBOX_IMAGE = resolveEveSandboxImage();
export const VERCEL_EVE_SANDBOX_IMAGE = resolveVercelEveSandboxImage();
