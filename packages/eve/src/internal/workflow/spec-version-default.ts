/** Spec version eve opts new Workflow runs into: one orchestrator per run. */
export const EVE_WORKFLOW_SPEC_VERSION = 9;

/**
 * Opts new Workflow runs into {@link EVE_WORKFLOW_SPEC_VERSION} unless the
 * operator chose a version. Worlds read the setting when `createWorld()`
 * runs, so this must be applied before every World eve constructs. A World
 * without the in-band writer fence ignores it and keeps creating spec 8 runs.
 */
export function applyWorkflowSpecVersionDefault(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  // `WORKFLOW_SEALED_LOG` is Workflow's older version switch; an operator who
  // set it has already chosen.
  if (isSet(env.WORKFLOW_SPEC_VERSION) || isSet(env.WORKFLOW_SEALED_LOG)) return;
  env.WORKFLOW_SPEC_VERSION = String(EVE_WORKFLOW_SPEC_VERSION);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
