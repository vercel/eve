import type { PlatformBuild } from "#platform/types.js";

export const vercelBuild: PlatformBuild = {
  target: () => (process.env.VERCEL ? "vercel" : "node"),
};
