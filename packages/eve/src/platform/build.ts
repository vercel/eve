import type { PlatformDeclaration } from "#platform/declaration.js";
import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

export function platformBuild(declaration?: PlatformDeclaration): Build {
  return declaration === undefined ? vercelBuild : (declaration.build ?? {});
}
