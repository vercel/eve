import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEVELOPMENT_RUNTIME_ARTIFACTS_ACTIVATED_MARKER = "activated";

const DEVELOPMENT_RUNTIME_ARTIFACTS_RETIRED_METADATA = "retired.json";
const DEVELOPMENT_RUNTIME_SNAPSHOT_GRACE_PERIOD_MS = 30 * 60 * 1_000;
const DEVELOPMENT_RUNTIME_SNAPSHOT_RETAIN_COUNT = 5;
const DEVELOPMENT_RUNTIME_SNAPSHOT_RETAIN_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Records the instant at which an activated generation stopped being current. */
export async function recordRetiredDevelopmentRuntimeArtifactsSnapshot(
  snapshotRoot: string,
  retiredAt = Date.now(),
): Promise<void> {
  await writeFile(
    join(snapshotRoot, DEVELOPMENT_RUNTIME_ARTIFACTS_RETIRED_METADATA),
    `${JSON.stringify({ retiredAt })}\n`,
  );
}

interface InspectedSnapshot {
  readonly activated: boolean;
  readonly active: boolean;
  readonly mtimeMs: number;
  readonly path: string;
  readonly retiredAt: number | undefined;
}

/** Applies the bounded retention policy within one dev snapshot directory. */
export async function pruneDevelopmentRuntimeArtifactsSnapshotDirectory(input: {
  readonly activeSnapshotRoot: string | undefined;
  readonly gracePeriodMs?: number;
  readonly now?: number;
  readonly protectAll: boolean;
  readonly retainCount?: number;
  readonly retainWindowMs?: number;
  readonly snapshotsDirectory: string;
}): Promise<void> {
  if (input.protectAll) {
    return;
  }
  const now = input.now ?? Date.now();
  const gracePeriodMs = Math.max(
    0,
    input.gracePeriodMs ?? DEVELOPMENT_RUNTIME_SNAPSHOT_GRACE_PERIOD_MS,
  );
  const retainCount = Math.max(
    0,
    Math.trunc(input.retainCount ?? DEVELOPMENT_RUNTIME_SNAPSHOT_RETAIN_COUNT),
  );
  const retainWindowMs = Math.max(
    0,
    input.retainWindowMs ?? DEVELOPMENT_RUNTIME_SNAPSHOT_RETAIN_WINDOW_MS,
  );
  let entries: Dirent<string>[];
  try {
    entries = await readdir(input.snapshotsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const activeSnapshotRoot =
    input.activeSnapshotRoot === undefined ? undefined : resolve(input.activeSnapshotRoot);
  const snapshots = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(
          async (entry) =>
            await inspectSnapshot({
              activeSnapshotRoot,
              entryName: entry.name,
              now,
              snapshotsDirectory: input.snapshotsDirectory,
            }),
        ),
    )
  ).flatMap((snapshot) => (snapshot === undefined ? [] : [snapshot]));

  const retainedRetiredPaths = new Set(
    snapshots
      .flatMap((snapshot) => {
        if (!snapshot.activated || snapshot.active) {
          return [];
        }
        const retiredAt = effectiveRetirementTime(snapshot);
        return now - retiredAt <= retainWindowMs ? [{ path: snapshot.path, retiredAt }] : [];
      })
      .sort((left, right) => right.retiredAt - left.retiredAt)
      .slice(0, retainCount)
      .map((snapshot) => snapshot.path),
  );

  await Promise.all(
    snapshots.map(async (snapshot) => {
      if (
        snapshot.active ||
        retainedRetiredPaths.has(snapshot.path) ||
        (snapshot.activated && now - effectiveRetirementTime(snapshot) <= gracePeriodMs) ||
        (!snapshot.activated && now - snapshot.mtimeMs <= gracePeriodMs)
      ) {
        return;
      }
      await rm(snapshot.path, { force: true, recursive: true }).catch((error) => {
        console.warn(
          `[eve:dev] failed to remove runtime generation "${snapshot.path}": ${String(error)}`,
        );
      });
    }),
  );
}

/**
 * Falls back to the staging time when retirement metadata is unreadable so a
 * generation whose `retired.json` could not be written (for example on a full
 * disk) still decays instead of being retained forever.
 */
function effectiveRetirementTime(snapshot: InspectedSnapshot): number {
  return snapshot.retiredAt ?? snapshot.mtimeMs;
}

async function inspectSnapshot(input: {
  readonly activeSnapshotRoot: string | undefined;
  readonly entryName: string;
  readonly now: number;
  readonly snapshotsDirectory: string;
}): Promise<InspectedSnapshot | undefined> {
  const path = join(input.snapshotsDirectory, input.entryName);
  try {
    const active = input.activeSnapshotRoot === resolve(path);
    const activated = existsSync(join(path, DEVELOPMENT_RUNTIME_ARTIFACTS_ACTIVATED_MARKER));
    let retiredAt: number | undefined;
    if (activated && !active) {
      try {
        retiredAt = await readRetiredAt(path);
        if (retiredAt === undefined) {
          await recordRetiredDevelopmentRuntimeArtifactsSnapshot(path, input.now);
          retiredAt = input.now;
        }
      } catch (error) {
        console.warn(
          `[eve:dev] failed to read or initialize runtime generation retirement metadata for "${path}": ${String(error)}`,
        );
      }
    }
    return {
      activated,
      active,
      path,
      retiredAt,
      mtimeMs: (await stat(path)).mtimeMs,
    };
  } catch (error) {
    // A snapshot that cannot be inspected is left in place: never delete what
    // the policy could not evaluate.
    console.warn(
      `[eve:dev] skipping runtime generation "${path}" during pruning: ${String(error)}`,
    );
    return undefined;
  }
}

async function readRetiredAt(snapshotRoot: string): Promise<number | undefined> {
  let source: string;
  try {
    source = await readFile(
      join(snapshotRoot, DEVELOPMENT_RUNTIME_ARTIFACTS_RETIRED_METADATA),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    "retiredAt" in metadata &&
    typeof metadata.retiredAt === "number" &&
    Number.isFinite(metadata.retiredAt) &&
    metadata.retiredAt >= 0
  ) {
    return metadata.retiredAt;
  }
  return undefined;
}
