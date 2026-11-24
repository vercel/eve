import type { BuildContribution } from "#execution/durable.js";
import type { PlatformDeclaration } from "#platform/declaration.js";
import type { Build } from "#platform/entities.js";
import { vercelBuild } from "#platform/vercel/build.js";

export function platformBuild(declaration?: PlatformDeclaration): Build {
  return declaration === undefined ? vercelBuild : (declaration.build ?? {});
}

export function platformDurableBuild(
  declaration?: PlatformDeclaration,
): BuildContribution | undefined {
  return declaration?.durable === undefined ? undefined : (declaration.durable().build ?? {});
}
