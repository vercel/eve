import { z } from "#compiled/zod/index.js";
import type { SandboxPreparedArtifact } from "#shared/sandbox-provider.js";

export const SANDBOX_PREPARED_ARTIFACTS_KIND = "eve-sandbox-prepared-artifacts";
export const SANDBOX_PREPARED_ARTIFACTS_VERSION = 1;

export interface SandboxPreparedArtifactEntry {
  readonly artifact: SandboxPreparedArtifact;
  readonly providerName: string;
  readonly templateName: string;
}

export interface SandboxPreparedArtifactsManifest {
  readonly entries: readonly SandboxPreparedArtifactEntry[];
  readonly kind: typeof SANDBOX_PREPARED_ARTIFACTS_KIND;
  readonly version: typeof SANDBOX_PREPARED_ARTIFACTS_VERSION;
}

const sandboxPreparedArtifactSchema: z.ZodType<SandboxPreparedArtifact> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(sandboxPreparedArtifactSchema),
    z.record(z.string(), sandboxPreparedArtifactSchema),
  ]),
);

export const sandboxPreparedArtifactsManifestSchema: z.ZodType<SandboxPreparedArtifactsManifest> = z
  .object({
    entries: z.array(
      z
        .object({
          artifact: sandboxPreparedArtifactSchema,
          providerName: z.string().min(1),
          templateName: z.string().min(1),
        })
        .strict(),
    ),
    kind: z.literal(SANDBOX_PREPARED_ARTIFACTS_KIND),
    version: z.literal(SANDBOX_PREPARED_ARTIFACTS_VERSION),
  })
  .strict();

export function createSandboxPreparedArtifactsManifest(
  entries: readonly SandboxPreparedArtifactEntry[],
): SandboxPreparedArtifactsManifest {
  return {
    entries: [...entries].sort((left, right) =>
      `${left.providerName}:${left.templateName}`.localeCompare(
        `${right.providerName}:${right.templateName}`,
      ),
    ),
    kind: SANDBOX_PREPARED_ARTIFACTS_KIND,
    version: SANDBOX_PREPARED_ARTIFACTS_VERSION,
  };
}
