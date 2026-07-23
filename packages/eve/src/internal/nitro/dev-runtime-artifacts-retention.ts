import { existsSync, type Dirent } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEVELOPMENT_RUNTIME_ARTIFACTS_ACTIVATED_MARKER = "activated";

const DEVELOPMENT_RUNTIME_ARTIFACTS_RETIRED_METADATA = "retired.json";
const DEVELOPMENT_RUNTIME_SNAPSHOT_GRACE_PERIOD_MS = 30 * 60 * 1_000;
const DEVELOPMENT_RUNTIME_SNAPSHOT_RETAIN_COUNT = 5;

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

/** Applies the bounded retention policy within one dev snapshot directory. */
export async function pruneDevelopmentRuntimeArtifactsSnapshotDirectory(input: {
  readonly activeSnapshotRoot: string | undefined;
  readonly gracePeriodMs?: number;
  readonly now?: number;
  readonly protectAll: boolean;
  readonly retainCount?: number;
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
  const snapshots = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(input.snapshotsDirectory, entry.name);
        const active = activeSnapshotRoot === resolve(path);
        const activated = existsSync(join(path, DEVELOPMENT_RUNTIME_ARTIFACTS_ACTIVATED_MARKER));
        let retiredAt: number | undefined;
        if (activated && !active) {
          try {
            retiredAt = await readRetiredAt(path);
            if (retiredAt === undefined) {
              await recordRetiredDevelopmentRuntimeArtifactsSnapshot(path, now);
              retiredAt = now;
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
      }),
  );
  const retainedRetiredPaths = new Set(
    snapshots
      .flatMap((snapshot) =>
        snapshot.retiredAt === undefined
          ? []
          : [{ path: snapshot.path, retiredAt: snapshot.retiredAt }],
      )
      .sort((left, right) => right.retiredAt - left.retiredAt)
      .slice(0, retainCount)
      .map((snapshot) => snapshot.path),
  );
  const retainedStagedPaths = new Set(
    snapshots
      .filter((snapshot) => !snapshot.activated)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, retainCount)
      .map((snapshot) => snapshot.path),
  );

  await Promise.all(
    snapshots.map(async (snapshot) => {
      if (
        snapshot.active ||
        (snapshot.activated && snapshot.retiredAt === undefined) ||
        retainedRetiredPaths.has(snapshot.path) ||
        retainedStagedPaths.has(snapshot.path) ||
        (snapshot.retiredAt !== undefined && now - snapshot.retiredAt <= gracePeriodMs) ||
        (!snapshot.activated && now - snapshot.mtimeMs <= gracePeriodMs)
      ) {
        return;
      }
      await rm(snapshot.path, { force: true, recursive: true });
    }),
  );
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
