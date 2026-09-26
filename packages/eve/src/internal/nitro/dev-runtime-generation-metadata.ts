import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface DevelopmentGenerationMetadata {
  readonly runtimeAppRoot: string;
  readonly recoveryVersion: 1;
}

const GENERATION_METADATA = "generation.json";

export function resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(appRoot: string): string {
  return join(appRoot, ".eve", "dev-runtime", "snapshots");
}

export async function listDevelopmentGenerationIds(appRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(appRoot), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** Finalizes metadata once, before the staged snapshot can be published. */
export async function finalizeDevelopmentGenerationMetadata(
  snapshotRoot: string,
  metadata: DevelopmentGenerationMetadata,
): Promise<void> {
  await writeFile(join(snapshotRoot, GENERATION_METADATA), `${JSON.stringify(metadata)}\n`, {
    flag: "wx",
  });
}

export async function readDevelopmentGenerationMetadata(
  appRoot: string,
  generationId: string,
): Promise<
  | { readonly kind: "ready"; readonly metadata: DevelopmentGenerationMetadata }
  | { readonly kind: "missing" }
  | { readonly kind: "legacy" }
  | { readonly kind: "invalid" }
> {
  if (
    !generationId ||
    generationId === "." ||
    generationId === ".." ||
    basename(generationId) !== generationId
  ) {
    throw new Error("Workflow run references an invalid development generation.");
  }
  let source: string;
  try {
    source = await readFile(
      join(
        resolveDevelopmentRuntimeArtifactsSnapshotsDirectory(appRoot),
        generationId,
        GENERATION_METADATA,
      ),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(source);
  } catch {
    return { kind: "invalid" };
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    !("runtimeAppRoot" in metadata) ||
    typeof metadata.runtimeAppRoot !== "string" ||
    metadata.runtimeAppRoot.length === 0
  ) {
    return { kind: "invalid" };
  }
  if (!("recoveryVersion" in metadata)) return { kind: "legacy" };
  if (metadata.recoveryVersion !== 1) return { kind: "invalid" };
  return {
    kind: "ready",
    metadata: { runtimeAppRoot: metadata.runtimeAppRoot, recoveryVersion: 1 },
  };
}
