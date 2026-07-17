import type { DurableDynamicSkillMetadata } from "#context/keys.js";
import type { DynamicSkillMaterializationMarkerRead } from "#context/dynamic-skill-materialization-marker.js";
import {
  dynamicSkillManifestMatchesSandbox,
  dynamicSkillMarkerFromManifest,
  dynamicSkillMarkerMatchesManifest,
} from "#context/dynamic-skill-materialization.js";
import type { ResolvedDynamicSkillResolver } from "#runtime/types.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

type DynamicSkillManifest = Readonly<Record<string, readonly DurableDynamicSkillMetadata[]>>;

export async function trustDynamicSkillMarker(input: {
  readonly manifest: DynamicSkillManifest;
  readonly markerRead: DynamicSkillMaterializationMarkerRead | undefined;
  readonly sandbox: SandboxSession | null | undefined;
}): Promise<DynamicSkillMaterializationMarkerRead | undefined> {
  const { manifest, markerRead, sandbox } = input;
  if (markerRead === undefined || sandbox === null || sandbox === undefined) return markerRead;

  if (markerRead.marker === null) {
    if (
      markerRead.status === "missing" &&
      Object.keys(manifest).length > 0 &&
      (await dynamicSkillManifestMatchesSandbox({ manifest, sandbox }))
    ) {
      const marker = dynamicSkillMarkerFromManifest(manifest);
      return marker === null ? markerRead : { ...markerRead, marker };
    }
    return markerRead;
  }

  return !dynamicSkillMarkerMatchesManifest(markerRead.marker, manifest) ||
    !(await dynamicSkillManifestMatchesSandbox({ manifest, sandbox }))
    ? { ...markerRead, status: "stale" }
    : markerRead;
}

export function isFullRematerialization(
  markerRead: DynamicSkillMaterializationMarkerRead | undefined,
): boolean {
  return markerRead !== undefined && (markerRead.marker === null || markerRead.status === "stale");
}

export function dynamicSkillManifestsEqual(
  left: DynamicSkillManifest,
  right: DynamicSkillManifest,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function retainCompiledResolverPackages(
  manifest: DynamicSkillManifest,
  resolvers: readonly ResolvedDynamicSkillResolver[],
): Record<string, readonly DurableDynamicSkillMetadata[]> {
  const compiledResolverSlugs = new Set(resolvers.map((resolver) => resolver.slug));
  return Object.fromEntries(
    Object.entries(manifest).filter(([resolverSlug]) => compiledResolverSlugs.has(resolverSlug)),
  );
}
