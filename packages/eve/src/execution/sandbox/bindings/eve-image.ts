// Content tag of packages/eve/Dockerfile, kept in sync by
// `pnpm sandbox-image:tag --write` and checked in CI. Releases that do not
// change the Dockerfile keep the same image, so sandbox templates survive
// eve upgrades.
const EVE_SANDBOX_IMAGE_TAG = "dockerfile-fc0279bf1664";

const tag = process.env.EVE_SANDBOX_IMAGE_TAG?.trim() || EVE_SANDBOX_IMAGE_TAG;

export const DEFAULT_EVE_SANDBOX_IMAGE = `ghcr.io/vercel/eve:${tag}`;
export const VERCEL_EVE_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/base:${tag}`;
