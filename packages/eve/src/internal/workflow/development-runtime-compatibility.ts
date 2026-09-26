import { readDevelopmentGenerationMetadata } from "#internal/nitro/dev-runtime-generation-metadata.js";

export type DevelopmentGenerationAvailability =
  | { readonly kind: "ready"; readonly runtimeAppRoot: string }
  | { readonly kind: "missing"; readonly reason: string }
  | { readonly kind: "ineligible"; readonly reason: string };

/** Recovery checks snapshot readability, not whether changed code will replay successfully. */
export async function readDevelopmentGenerationAvailability(
  appRoot: string,
  generationId: string,
): Promise<DevelopmentGenerationAvailability> {
  const retained = await readDevelopmentGenerationMetadata(appRoot, generationId);
  if (retained.kind === "missing") {
    return { kind: "missing", reason: "Development runtime snapshot is no longer available" };
  }
  if (retained.kind === "invalid") {
    return {
      kind: "ineligible",
      reason:
        "Development generation metadata is invalid. Restore the affected snapshot from a backup or start a new session.",
    };
  }
  return { kind: "ready", runtimeAppRoot: retained.metadata.runtimeAppRoot };
}
