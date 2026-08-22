/**
 * Maps a configured workflow world target to its package import specifier,
 * mirroring the Workflow DevKit's `WORKFLOW_TARGET_WORLD` normalization:
 * `"local"` and `"vercel"` are shorthands for the first-party world
 * packages; anything else is already a specifier.
 */
export function resolveWorkflowWorldImport(targetWorld: string): string {
  if (targetWorld === "local") return "@workflow/world-local";
  if (targetWorld === "vercel") return "@workflow/world-vercel";
  return targetWorld;
}
