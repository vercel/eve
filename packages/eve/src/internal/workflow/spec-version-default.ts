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

/**
 * How long a session's orchestrator stays live after a turn, waiting for its next message.
 * Workflow's 5s default suits a hook that is rarely resumed; a person usually replies to a
 * session later than that, and a message that arrives after the orchestrator left waits for a
 * queue delivery that reloads and replays the session. Workflow caps it at
 * `WORKFLOW_ORCHESTRATOR_LINGER_MS`, 30s by default.
 */
export const EVE_WORKFLOW_HOOK_LINGER_MS = 30_000;

/** Keeps a session's orchestrator live between turns unless the operator chose a linger. */
export function applyWorkflowHookLingerDefault(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): void {
  if (isSet(env.WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS)) return;
  env.WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS = String(EVE_WORKFLOW_HOOK_LINGER_MS);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
