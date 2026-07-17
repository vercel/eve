import type { DurableDynamicSkillMetadata } from "#context/keys.js";
import {
  dynamicSkillPackageMatchesSandbox,
  readVerifiedAuthoredSkillBaseline,
  writeVisibleSkillPackage,
} from "#context/dynamic-skill-authored-baseline.js";
import {
  type DynamicSkillMaterializationMarker,
  type DynamicSkillMaterializationMarkerEntry,
  type DynamicSkillMaterializationMarkerRead,
  type DynamicSkillMaterializationMarkerStatus,
  writeDynamicSkillMaterializationMarker,
} from "#context/dynamic-skill-materialization-marker.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  type MaterializableSkillPackage,
  removeSkillPackageFromSandbox,
  writeSkillPackageToSandbox,
} from "#shared/skill-package.js";
import { resolveSandboxSkillWritePath } from "#shared/skill-paths.js";

type DynamicSkillManifest = Readonly<Record<string, readonly DurableDynamicSkillMetadata[]>>;

export interface DynamicSkillMaterializationUpdate {
  readonly resolverSlug: string;
  readonly skills: readonly MaterializableSkillPackage[];
}

export interface DynamicSkillMaterializationResult {
  readonly addedPackageCount: number;
  readonly changedPackageCount: number;
  readonly fullRematerialization: boolean;
  readonly markerMs: number;
  readonly markerStatus: DynamicSkillMaterializationMarkerStatus;
  readonly markerWriteCount: number;
  readonly markerWriteMs: number;
  readonly removeCallCount: number;
  readonly removeMs: number;
  readonly removedPackageCount: number;
  readonly unchangedPackageCount: number;
  readonly writeByteCount: number;
  readonly writeFileCount: number;
  readonly writeMs: number;
  readonly writePackageCount: number;
}

/** Returns whether one marker exactly describes the durable package manifest. */
export function dynamicSkillMarkerMatchesManifest(
  marker: DynamicSkillMaterializationMarker,
  manifest: DynamicSkillManifest,
): boolean {
  const indexedManifest = indexManifest(manifest);
  const markedNames = Object.keys(marker.packages);
  return (
    markedNames.length === indexedManifest.size &&
    [...indexedManifest].every(
      ([name, metadata]) =>
        metadata.contentDigest !== undefined &&
        metadata.relativePaths !== undefined &&
        markerEntryMatches(marker.packages[name], {
          contentDigest: metadata.contentDigest,
          relativePaths: metadata.relativePaths,
          resolverSlug: metadata.resolverSlug,
        }),
    )
  );
}

/** Builds migration proof for exact pre-marker packages. */
export function dynamicSkillMarkerFromManifest(
  manifest: DynamicSkillManifest,
): DynamicSkillMaterializationMarker | null {
  const indexedManifest = indexManifest(manifest);
  const packageCount = Object.values(manifest).reduce((total, skills) => total + skills.length, 0);
  if (indexedManifest.size !== packageCount) return null;

  const packages: Record<string, DynamicSkillMaterializationMarkerEntry> = {};
  for (const [name, metadata] of indexedManifest) {
    if (metadata.contentDigest === undefined || metadata.relativePaths === undefined) return null;
    packages[name] = {
      contentDigest: metadata.contentDigest,
      relativePaths: metadata.relativePaths,
      resolverSlug: metadata.resolverSlug,
    };
  }

  return { packages, version: 1 };
}

/** Returns whether durable metadata still describes the exact managed sandbox bytes. */
export async function dynamicSkillManifestMatchesSandbox(input: {
  readonly manifest: DynamicSkillManifest;
  readonly sandbox: SandboxSession;
}): Promise<boolean> {
  for (const [name, metadata] of indexManifest(input.manifest)) {
    if (
      !(await dynamicSkillPackageMatchesSandbox({
        metadata: { ...metadata, name },
        sandbox: input.sandbox,
      }))
    )
      return false;
  }

  return true;
}

/** Returns whether a legacy manifest still has every package entry in this sandbox. */
export async function legacyDynamicSkillManifestExistsInSandbox(input: {
  readonly manifest: DynamicSkillManifest;
  readonly sandbox: SandboxSession;
}): Promise<boolean> {
  let hasLegacyMetadata = false;

  for (const [name, metadata] of indexManifest(input.manifest)) {
    if (metadata.contentDigest !== undefined && metadata.relativePaths !== undefined) {
      if (
        !(await dynamicSkillPackageMatchesSandbox({
          metadata: { ...metadata, name },
          sandbox: input.sandbox,
        }))
      )
        return false;
      continue;
    }

    hasLegacyMetadata = true;
    const skillBody = await input.sandbox.readBinaryFile({
      path: await resolveSandboxSkillWritePath({
        name,
        relativePath: "SKILL.md",
        sandbox: input.sandbox,
      }),
    });
    if (skillBody === null) return false;
  }

  return hasLegacyMetadata;
}

/** Applies one dynamic-skill delta and commits its sandbox marker last. */
export async function materializeDynamicSkillUpdates(input: {
  readonly nextManifest: DynamicSkillManifest;
  readonly markerMs: number;
  readonly markerRead: DynamicSkillMaterializationMarkerRead;
  readonly previousManifest: DynamicSkillManifest;
  readonly sandbox: SandboxSession;
  readonly updates: readonly DynamicSkillMaterializationUpdate[];
}): Promise<DynamicSkillMaterializationResult> {
  const currentMarker = input.markerRead.marker;
  const fullRematerialization = currentMarker === null || input.markerRead.status === "stale";

  const previous = indexManifest(input.previousManifest);
  const desired = indexManifest(input.nextManifest);
  const updates = indexUpdates(input.updates);
  const nextPackages: Record<string, DynamicSkillMaterializationMarkerEntry> =
    fullRematerialization || currentMarker === null ? {} : { ...currentMarker.packages };
  const removePackages = new Set<string>();
  const writeSkills: MaterializableSkillPackage[] = [];

  if (fullRematerialization) {
    for (const name of previous.keys()) removePackages.add(name);
  } else {
    reconcileMarkedPackages({ currentMarker, desired, removePackages, updates });
  }

  for (const [name, update] of updates) {
    const nextEntry = markerEntry(update);
    const currentEntry = currentMarker?.packages[name];

    if (!fullRematerialization && markerEntryMatches(currentEntry, nextEntry)) {
      nextPackages[name] = nextEntry;
      continue;
    }

    // Replace a changed package as one unit. Besides deleting stale siblings,
    // this handles path topology changes such as `references/x.md` becoming a
    // file named `references`, which cannot be reconciled file-by-file safely.
    if (!fullRematerialization && currentEntry !== undefined) removePackages.add(name);

    writeSkills.push(update.skill);
    nextPackages[name] = nextEntry;
  }

  for (const name of removePackages) {
    if (!updates.has(name)) delete nextPackages[name];
  }

  const freshAuthoredPackages = new Set(
    [...removePackages].filter((name) => {
      const previousMetadata = previous.get(name);
      return (
        desired.get(name)?.authoredBaseline === undefined &&
        previousMetadata?.authoredBaseline !== undefined &&
        previousMetadata.authoredBaselineSandboxId !== undefined &&
        previousMetadata.authoredBaselineSandboxId !== input.sandbox.id
      );
    }),
  );
  const filesystemRemovePackages = new Set(
    [...removePackages].filter((name) => !freshAuthoredPackages.has(name)),
  );
  const restorePackages = await Promise.all(
    [...filesystemRemovePackages].flatMap((name) => {
      const baseline = desired.get(name)?.authoredBaseline ?? previous.get(name)?.authoredBaseline;
      return baseline === undefined
        ? []
        : [
            readVerifiedAuthoredSkillBaseline({ baseline, name, sandbox: input.sandbox }).then(
              (files) => ({ files, name }),
            ),
          ];
    }),
  );
  const packageMutationNeeded =
    filesystemRemovePackages.size > 0 || restorePackages.length > 0 || writeSkills.length > 0;
  if (packageMutationNeeded) {
    await input.sandbox.removePath({ force: true, path: input.markerRead.path });
  }

  const removeStartedAt = performance.now();
  for (const name of [...filesystemRemovePackages].sort()) {
    await removeSkillPackageFromSandbox({ name, sandbox: input.sandbox });
  }
  const removeMs = performance.now() - removeStartedAt;

  const writeStartedAt = performance.now();
  for (const restored of restorePackages) {
    await writeVisibleSkillPackage({ ...restored, sandbox: input.sandbox });
  }
  for (const skill of writeSkills) {
    await writeSkillPackageToSandbox({ sandbox: input.sandbox, skill });
  }
  const writeMs = performance.now() - writeStartedAt;

  const nextMarker: DynamicSkillMaterializationMarker = { packages: nextPackages, version: 1 };
  const markerChanged =
    currentMarker === null || !markerPackagesEqual(currentMarker.packages, nextMarker.packages);
  const markerWriteStartedAt = performance.now();
  const markerWriteNeeded =
    markerChanged || packageMutationNeeded || input.markerRead.status !== "current";
  if (markerWriteNeeded) {
    await writeDynamicSkillMaterializationMarker({
      marker: nextMarker,
      path: input.markerRead.path,
      sandbox: input.sandbox,
    });
  }
  const markerWriteMs = performance.now() - markerWriteStartedAt;

  const classification = classifyUpdates({ desired, previous, updates });
  const removedPackageCount = [...previous.keys()].filter((name) => !desired.has(name)).length;

  return {
    ...classification,
    fullRematerialization,
    markerMs: input.markerMs,
    markerStatus: input.markerRead.status,
    markerWriteCount: markerWriteNeeded ? 1 : 0,
    markerWriteMs,
    removeCallCount: filesystemRemovePackages.size,
    removeMs,
    removedPackageCount,
    writeByteCount:
      restorePackages.reduce(
        (total, restored) =>
          total + restored.files.reduce((sum, file) => sum + file.content.byteLength, 0),
        0,
      ) +
      writeSkills.reduce(
        (total, skill) =>
          total + skill.files.reduce((sum, file) => sum + file.content.byteLength, 0),
        0,
      ),
    writeFileCount:
      restorePackages.reduce((total, restored) => total + restored.files.length, 0) +
      writeSkills.reduce((total, skill) => total + skill.files.length, 0),
    writeMs,
    writePackageCount: restorePackages.length + writeSkills.length,
  };
}

interface IndexedMetadata extends DurableDynamicSkillMetadata {
  readonly resolverSlug: string;
}

interface IndexedUpdate {
  readonly resolverSlug: string;
  readonly skill: MaterializableSkillPackage;
}

function indexManifest(manifest: DynamicSkillManifest): Map<string, IndexedMetadata> {
  return new Map(
    Object.entries(manifest).flatMap(([resolverSlug, skills]) =>
      skills.map((skill) => [skill.name, { ...skill, resolverSlug }] as const),
    ),
  );
}

function indexUpdates(
  updates: readonly DynamicSkillMaterializationUpdate[],
): Map<string, IndexedUpdate> {
  return new Map(
    updates.flatMap((update) =>
      update.skills.map((skill) => [skill.name, { resolverSlug: update.resolverSlug, skill }]),
    ),
  );
}

function markerEntry(update: IndexedUpdate): DynamicSkillMaterializationMarkerEntry {
  return {
    contentDigest: update.skill.contentDigest,
    relativePaths: update.skill.files.map((file) => file.relativePath),
    resolverSlug: update.resolverSlug,
  };
}

function reconcileMarkedPackages(input: {
  readonly currentMarker: DynamicSkillMaterializationMarker;
  readonly desired: ReadonlyMap<string, IndexedMetadata>;
  readonly removePackages: Set<string>;
  readonly updates: ReadonlyMap<string, IndexedUpdate>;
}): void {
  for (const [name, marked] of Object.entries(input.currentMarker.packages)) {
    const desired = input.desired.get(name);
    if (input.updates.has(name)) continue;
    if (
      desired?.contentDigest !== marked.contentDigest ||
      desired.resolverSlug !== marked.resolverSlug ||
      !pathsEqual(desired.relativePaths, marked.relativePaths)
    ) {
      input.removePackages.add(name);
    }
  }
}

function classifyUpdates(input: {
  readonly desired: ReadonlyMap<string, IndexedMetadata>;
  readonly previous: ReadonlyMap<string, IndexedMetadata>;
  readonly updates: ReadonlyMap<string, IndexedUpdate>;
}): Pick<
  DynamicSkillMaterializationResult,
  "addedPackageCount" | "changedPackageCount" | "unchangedPackageCount"
> {
  let addedPackageCount = 0;
  let changedPackageCount = 0;
  let unchangedPackageCount = 0;

  for (const name of input.updates.keys()) {
    const previous = input.previous.get(name);
    const desired = input.desired.get(name)!;
    if (previous === undefined) addedPackageCount += 1;
    else if (
      previous.contentDigest === desired.contentDigest &&
      pathsEqual(previous.relativePaths, desired.relativePaths)
    ) {
      unchangedPackageCount += 1;
    } else changedPackageCount += 1;
  }

  return { addedPackageCount, changedPackageCount, unchangedPackageCount };
}

function markerEntryMatches(
  left: DynamicSkillMaterializationMarkerEntry | undefined,
  right: DynamicSkillMaterializationMarkerEntry,
): boolean {
  return (
    left?.contentDigest === right.contentDigest &&
    left.resolverSlug === right.resolverSlug &&
    pathsEqual(left.relativePaths, right.relativePaths)
  );
}

function markerPackagesEqual(
  left: Readonly<Record<string, DynamicSkillMaterializationMarkerEntry>>,
  right: Readonly<Record<string, DynamicSkillMaterializationMarkerEntry>>,
): boolean {
  const leftNames = Object.keys(left);
  const rightNames = Object.keys(right);
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name) => {
      const rightEntry = right[name];
      return rightEntry !== undefined && markerEntryMatches(left[name], rightEntry);
    })
  );
}

function pathsEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.length === right.length &&
    left.every((path, i) => path === right[i])
  );
}
