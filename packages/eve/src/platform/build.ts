import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

export function platformBuild(): Build {
  return vercelBuild;
}
