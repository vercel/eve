import type { TurnCaller } from "#channel/types.js";
import { resolveInitialTurnCallerStep } from "#execution/delegated-parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

const SAFE_OUTER_WORKFLOW_FAILURE_MESSAGE =
  "Agent workflow failed. Inspect the private session trace for details.";

/** Latest driver values required to discharge outer crash cleanup. */
export interface CrashCleanupState {
  caller: TurnCaller | undefined;
  callerResolved: boolean;
  lastSessionState: DurableSessionState | undefined;
}

/** Resolves the delegated caller when failure preceded normal caller setup. */
export async function resolveCallerForCrash(
  state: CrashCleanupState,
  serializedContext: Record<string, unknown>,
): Promise<TurnCaller | undefined> {
  if (state.callerResolved) return state.caller;
  try {
    return await resolveInitialTurnCallerStep({ serializedContext });
  } catch {
    return undefined;
  }
}

export function createSafeOuterWorkflowError(): Error {
  const error = new Error(SAFE_OUTER_WORKFLOW_FAILURE_MESSAGE);
  error.name = "EveWorkflowFailure";
  return error;
}
