import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

export interface DevelopmentGenerationMetadata {
  readonly runtimeAppRoot: string;
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

export async function readDevelopmentGenerationMetadata(
  appRoot: string,
  generationId: string,
): Promise<
  | { readonly kind: "ready"; readonly metadata: DevelopmentGenerationMetadata }
  | { readonly kind: "missing" }
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
  return {
    kind: "ready",
    metadata: { runtimeAppRoot: metadata.runtimeAppRoot },
  };
}
