import { installedPlatform } from "#platform/context.js";
import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

export function platformBuild(): Build {
  return installedPlatform()?.build ?? vercelBuild;
}
