import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const GHCR_EVE_SANDBOX_IMAGE_REPOSITORY = "ghcr.io/vercel/eve";
const VERCEL_EVE_SANDBOX_IMAGE =
  "vercel/eve/base@sha256:d8d53829d9f05d54a889619603121499e911c467ea22345c28e572a60f613329";

export function resolveEveSandboxImage(): string {
  return `${GHCR_EVE_SANDBOX_IMAGE_REPOSITORY}:${resolveEveSandboxImageTag()}`;
}

export function resolveVercelEveSandboxImage(): string {
  return VERCEL_EVE_SANDBOX_IMAGE;
}

function resolveEveSandboxImageTag(): string {
  const override = process.env.EVE_SANDBOX_IMAGE_TAG?.trim();
  return override !== undefined && override.length > 0
    ? override
    : resolveInstalledPackageInfo().version;
}

export const DEFAULT_EVE_SANDBOX_IMAGE = resolveEveSandboxImage();
export { VERCEL_EVE_SANDBOX_IMAGE };
