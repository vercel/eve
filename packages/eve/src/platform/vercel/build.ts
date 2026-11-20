import type { PlatformBuild } from "#platform/types.js";
import { isVercelEnvironment } from "#platform/vercel/environment.js";

export const vercelBuild: PlatformBuild = {
  target: () => (isVercelEnvironment() ? "vercel" : "node"),
};
