/**
 * Maps a configured workflow world target to its package import specifier.
 *
 * Mirrors the normalization the Workflow DevKit applies to
 * `WORKFLOW_TARGET_WORLD` (`"local"` and `"vercel"` are shorthands for the
 * first-party world packages; anything else is already a specifier). Owned
 * by eve so builds do not depend on `@workflow/utils` keeping the helper
 * exported.
 */
export function resolveWorkflowWorldImport(targetWorld: string): string {
  if (targetWorld === "local") return "@workflow/world-local";
  if (targetWorld === "vercel") return "@workflow/world-vercel";
  return targetWorld;
}
