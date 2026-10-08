/**
 * Maps a configured workflow world target to its package import specifier,
 * mirroring the Workflow DevKit's `WORKFLOW_TARGET_WORLD` normalization:
 * `"local"` and `"vercel"` are shorthands for the first-party world
 * packages; anything else is already a specifier.
 */
export function resolveWorkflowWorldImport(targetWorld: string): string {
  if (targetWorld === "hub") return "eve/world-hub";
  if (targetWorld === "local") return "@workflow/world-local";
  if (targetWorld === "vercel") return "@workflow/world-vercel";
  return targetWorld;
}

export function usesHubWorkflowWorld(target: string | undefined): boolean {
  const effective = resolveConfiguredWorkflowWorld(target);
  return effective !== undefined && resolveWorkflowWorldImport(effective) === "eve/world-hub";
}

/** Environment selection takes precedence over authored config in dev and builds. */
export function resolveConfiguredWorkflowWorld(configured: string | undefined): string | undefined {
  return process.env.WORKFLOW_TARGET_WORLD?.trim() || configured;
}
