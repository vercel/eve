import { z } from "#compiled/zod/index.js";
import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  type CompileMetadata,
} from "#compiler/artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { formatValidationError } from "#runtime/validation.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

const compileArtifactDigestSchema = z
  .object({
    path: z.string(),
    sha256: z.string(),
  })
  .strict();

const compileMetadataSchema: z.ZodType<CompileMetadata> = z
  .object({
    compile: z
      .object({
        moduleMap: compileArtifactDigestSchema,
      })
      .strict(),
    discovery: z
      .object({
        diagnostics: compileArtifactDigestSchema,
        manifest: compileArtifactDigestSchema,
        sourceGraphHash: z.string(),
        summary: z
          .object({
            errors: z.number().finite(),
            warnings: z.number().finite(),
          })
          .strict(),
      })
      .strict(),
    generator: z
      .object({
        name: z.string(),
        version: z.string(),
      })
      .strict(),
    kind: z.literal(COMPILE_METADATA_KIND),
    status: z.union([z.literal("failed"), z.literal("ready")]),
    version: z.literal(COMPILE_METADATA_VERSION),
  })
  .strict();

const BUNDLED_COMPILE_METADATA_SOURCE = "bundled compile metadata";

/**
 * Input for loading compile metadata from disk or bundled artifacts.
 */
interface LoadCompileMetadataInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}

/**
 * Error raised when compile metadata cannot be loaded or validated.
 */
class LoadCompileMetadataError extends Error {
  readonly metadataPath?: string;

  constructor(message: string, metadataPath?: string) {
    super(message);
    this.name = "LoadCompileMetadataError";

    if (metadataPath !== undefined) {
      this.metadataPath = metadataPath;
    }
  }
}

/**
 * Loads and validates compile metadata when it is available for the current
 * artifact source.
 */
export async function loadCompileMetadata(
  input: LoadCompileMetadataInput,
): Promise<CompileMetadata | null> {
  const metadataPath =
    input.compiledArtifactsSource.kind === "disk"
      ? resolveRuntimeCompilerArtifactPaths(input.compiledArtifactsSource.appRoot)
          .compileMetadataPath
      : undefined;

  if (metadataPath !== undefined) {
    const { readFile } = await import("node:fs/promises");
    let metadataJson: unknown;

    try {
      metadataJson = JSON.parse(await readFile(metadataPath, "utf8"));
    } catch (error) {
      throw new LoadCompileMetadataError(formatLoadErrorMessage(error), metadataPath);
    }

    return parseCompileMetadata(metadataJson, metadataPath);
  }

  const bundledArtifacts = readBundledCompiledArtifacts();
  const bundledMetadata = bundledArtifacts?.metadata;

  return bundledMetadata === undefined
    ? null
    : parseCompileMetadata(bundledMetadata, BUNDLED_COMPILE_METADATA_SOURCE);
}

function parseCompileMetadata(value: unknown, metadataPath: string): CompileMetadata {
  const parsed = compileMetadataSchema.safeParse(value);

  if (!parsed.success) {
    throw new LoadCompileMetadataError(
      `Expected "${metadataPath}" to contain valid eve compile metadata. ${formatValidationError(parsed.error)}`,
      metadataPath,
    );
  }

  return parsed.data;
}

function formatLoadErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown compile metadata load failure.";
}
