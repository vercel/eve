const EVE_SANDBOX_IMAGE_TAG = "dockerfile-a22b7f0d63c2";
const EVE_GIT_SANDBOX_IMAGE_TAG = "git-d74c717f1d17";

const tag = process.env.EVE_SANDBOX_IMAGE_TAG?.trim() || EVE_SANDBOX_IMAGE_TAG;

export const DEFAULT_EVE_SANDBOX_IMAGE = `ghcr.io/vercel/eve:${tag}`;
export const VERCEL_EVE_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/base:${tag}`;

/** eve-git image reference for Docker: the default image plus the GitHub CLI (`gh`), pinned to this eve release. */
export const DEFAULT_EVE_GIT_SANDBOX_IMAGE = `ghcr.io/vercel/eve-git:${EVE_GIT_SANDBOX_IMAGE_TAG}`;
/** eve-git image reference for Vercel Sandbox: the default image plus the GitHub CLI (`gh`), pinned to this eve release. */
export const VERCEL_EVE_GIT_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/git:${EVE_GIT_SANDBOX_IMAGE_TAG}`;
