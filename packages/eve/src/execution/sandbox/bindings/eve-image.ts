const EVE_SANDBOX_IMAGE_TAG = "dockerfile-fc0279bf1664";

const tag = process.env.EVE_SANDBOX_IMAGE_TAG?.trim() || EVE_SANDBOX_IMAGE_TAG;

export const DEFAULT_EVE_SANDBOX_IMAGE = `ghcr.io/vercel/eve:${tag}`;
export const VERCEL_EVE_SANDBOX_IMAGE = `vcr.vercel.com/vercel/eve/base:${tag}`;
