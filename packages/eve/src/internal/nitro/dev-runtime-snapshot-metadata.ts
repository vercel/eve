import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const DEV_RUNTIME_SNAPSHOT_METADATA_FILE_NAME = "snapshot-metadata.json";
export const DEV_RUNTIME_SNAPSHOT_METADATA_KIND = "eve-dev-runtime-snapshot-metadata";
export const DEV_RUNTIME_SNAPSHOT_METADATA_VERSION = 1;

export interface DevelopmentRuntimeArtifactsSnapshotMetadata {
  readonly appRoot: string;
  readonly kind: typeof DEV_RUNTIME_SNAPSHOT_METADATA_KIND;
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
  readonly version: typeof DEV_RUNTIME_SNAPSHOT_METADATA_VERSION;
}

/**
 * Dev runtime snapshots execute immutable copied files, but debugger surfaces
 * need enough provenance to map those snapshot paths back to live workspace
 * files that users can edit and set breakpoints in.
 */
export async function writeDevelopmentRuntimeSnapshotMetadata(input: {
  readonly appRoot: string;
  readonly runtimeAppRoot: string;
  readonly snapshotRoot: string;
  readonly snapshotSourceRoot: string;
  readonly sourceRoot: string;
}): Promise<void> {
  const metadata: DevelopmentRuntimeArtifactsSnapshotMetadata = {
    appRoot: input.appRoot,
    kind: DEV_RUNTIME_SNAPSHOT_METADATA_KIND,
    runtimeAppRoot: input.runtimeAppRoot,
    snapshotRoot: input.snapshotRoot,
    snapshotSourceRoot: input.snapshotSourceRoot,
    sourceRoot: input.sourceRoot,
    version: DEV_RUNTIME_SNAPSHOT_METADATA_VERSION,
  };

  await writeFile(
    join(input.snapshotRoot, DEV_RUNTIME_SNAPSHOT_METADATA_FILE_NAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export function readDevelopmentRuntimeSnapshotMetadataForPath(
  path: string,
): DevelopmentRuntimeArtifactsSnapshotMetadata | undefined {
  let currentDirectory = dirname(resolve(path));

  while (true) {
    const metadataPath = join(currentDirectory, DEV_RUNTIME_SNAPSHOT_METADATA_FILE_NAME);
    if (existsSync(metadataPath)) {
      return readDevelopmentRuntimeSnapshotMetadata(metadataPath);
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

export function readDevelopmentRuntimeSnapshotMetadata(
  path: string,
): DevelopmentRuntimeArtifactsSnapshotMetadata | undefined {
  try {
    const metadata = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<DevelopmentRuntimeArtifactsSnapshotMetadata>;
    if (
      metadata.kind !== DEV_RUNTIME_SNAPSHOT_METADATA_KIND ||
      metadata.version !== DEV_RUNTIME_SNAPSHOT_METADATA_VERSION ||
      typeof metadata.appRoot !== "string" ||
      typeof metadata.runtimeAppRoot !== "string" ||
      typeof metadata.snapshotRoot !== "string" ||
      typeof metadata.snapshotSourceRoot !== "string" ||
      typeof metadata.sourceRoot !== "string"
    ) {
      return undefined;
    }

    return {
      appRoot: metadata.appRoot,
      kind: DEV_RUNTIME_SNAPSHOT_METADATA_KIND,
      runtimeAppRoot: metadata.runtimeAppRoot,
      snapshotRoot: metadata.snapshotRoot,
      snapshotSourceRoot: metadata.snapshotSourceRoot,
      sourceRoot: metadata.sourceRoot,
      version: DEV_RUNTIME_SNAPSHOT_METADATA_VERSION,
    };
  } catch {
    return undefined;
  }
}
