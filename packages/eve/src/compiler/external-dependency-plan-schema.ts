import { z } from "#compiled/zod/index.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const EXTERNAL_DEPENDENCY_CONDITIONS = ["node", "import", "default"] as const;

export const compiledExternalDependencyScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("application"),
      nodeId: z.string(),
      sourceRoot: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("extension"),
      namespace: z.string(),
      nodeId: z.string(),
      packageName: z.string(),
      sourceRoot: z.string(),
    })
    .strict(),
]);

export const compiledExternalDependencyPackageSchema = z
  .object({
    contentSha256: z.string().regex(SHA256_PATTERN),
    dependencies: z
      .array(
        z
          .object({
            packageId: z.string(),
            packageName: z.string(),
          })
          .strict(),
      )
      .readonly(),
    id: z.string(),
    packageName: z.string(),
    resolvedPackageRoot: z.string(),
  })
  .strict();

export const compiledExternalDependencyPlanEntrySchema = z
  .object({
    conditions: z.tuple([
      z.literal(EXTERNAL_DEPENDENCY_CONDITIONS[0]),
      z.literal(EXTERNAL_DEPENDENCY_CONDITIONS[1]),
      z.literal(EXTERNAL_DEPENDENCY_CONDITIONS[2]),
    ]),
    id: z.string(),
    packageName: z.string(),
    packages: z.array(compiledExternalDependencyPackageSchema).readonly(),
    rootPackageId: z.string(),
    scopes: z.array(compiledExternalDependencyScopeSchema).readonly(),
    semanticSha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

export const compiledExternalDependencyPlanSchema = z
  .object({
    entries: z.array(compiledExternalDependencyPlanEntrySchema).readonly(),
  })
  .strict();

export type CompiledExternalDependencyScope = z.infer<typeof compiledExternalDependencyScopeSchema>;
export type CompiledExternalDependencyPackage = z.infer<
  typeof compiledExternalDependencyPackageSchema
>;
export type CompiledExternalDependencyPlanEntry = z.infer<
  typeof compiledExternalDependencyPlanEntrySchema
>;
export type CompiledExternalDependencyPlan = z.infer<typeof compiledExternalDependencyPlanSchema>;
