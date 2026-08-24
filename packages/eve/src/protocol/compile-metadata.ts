import { z } from "#compiled/zod/index.js";

import { compilerDiagnosticsSummarySchema } from "#shared/compiler-diagnostics.js";

/** Stable compile metadata artifact kind emitted by the compiler. */
export const COMPILE_METADATA_KIND = "eve-compile-metadata";

/** Current compile metadata schema version. */
export const COMPILE_METADATA_VERSION = 7;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest.");

const compileArtifactDigestSchema = z
  .object({
    path: z.string(),
    sha256: sha256Schema,
  })
  .strict();

/** Runtime-safe schema for compiler metadata shared by disk and bundle loaders. */
export const compileMetadataSchema = z
  .object({
    compile: z
      .object({
        manifest: compileArtifactDigestSchema,
        materializedAuthoredModules: compileArtifactDigestSchema
          .extend({ fingerprintSha256: sha256Schema })
          .strict()
          .optional(),
        moduleMap: compileArtifactDigestSchema.extend({ identitySha256: sha256Schema }).strict(),
      })
      .strict(),
    discovery: z
      .object({
        diagnostics: compileArtifactDigestSchema,
        manifest: compileArtifactDigestSchema,
        sourceGraphHash: sha256Schema,
        summary: compilerDiagnosticsSummarySchema,
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

/** Metadata tying one emitted compiler artifact set to its exact source graph. */
export type CompileMetadata = z.infer<typeof compileMetadataSchema>;
