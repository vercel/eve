// Content tags of packages/eve/Dockerfile and packages/eve/Dockerfile.git, kept
// in sync by `pnpm sandbox-image:tag --write` and checked in CI. Releases that
// do not change a Dockerfile keep the same image, so sandbox templates survive
// eve upgrades.
const EVE_SANDBOX_IMAGE_TAG = "dockerfile-a22b7f0d63c2";
const EVE_GIT_SANDBOX_IMAGE_TAG = "git-b28f5b670399";

const tag = process.env.EVE_SANDBOX_IMAGE_TAG?.trim() || EVE_SANDBOX_IMAGE_TAG;

export const DEFAULT_EVE_SANDBOX_IMAGE = `ghcr.io/vercel/eve:${tag}`;
export const VERCEL_EVE_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/base:${tag}`;

// The default image plus `gh`. eve never selects these itself; authors opt in
// through `image`.
export const DEFAULT_EVE_GIT_SANDBOX_IMAGE = `ghcr.io/vercel/eve-git:${EVE_GIT_SANDBOX_IMAGE_TAG}`;
export const VERCEL_EVE_GIT_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/git:${EVE_GIT_SANDBOX_IMAGE_TAG}`;
