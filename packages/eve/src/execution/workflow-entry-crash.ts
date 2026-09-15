import type { TurnCaller } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";

const SAFE_OUTER_WORKFLOW_FAILURE_MESSAGE =
  "Agent workflow failed. Inspect the private session trace for details.";

/**
 * Write-through cell owned by `workflowEntry`: written
 * unconditionally by the session loop as turns advance, read only by the
 * outer catch. When the loop throws, its locals are unreachable, so this
 * cell is the crash path's only view of values that changed after turn 1.
 *
 * Reach for this cell only when all three hold for a value:
 * 1. it is produced or replaced inside the session loop, so the entry
 *    function's own locals go stale;
 * 2. it travels by value inside Workflow step results — there is no
 *    store the catch could re-read it from at crash time;
 * 3. the crash path needs its latest value to discharge a cleanup
 *    obligation.
 * If any of the three fails, read the value from where it already lives
 * instead of mirroring it here.
 */
export interface CrashCleanupState {
  // The caller whose awaited reply is still unsettled, so the catch can
  // reject it with the error instead of leaving it parked forever.
  // Populated for every session; only conversation-mode paths read it.
  caller: TurnCaller | undefined;
  // Whether `resolveInitialTurnCallerStep` has run. `caller: undefined` is
  // ambiguous on its own: it also means "resolved and later cleared because
  // its reply settled". This flag lets the crash path tell that apart from
  // "crashed before the caller was ever resolved", where a delegated caller
  // may still be parked on this session's reply.
  callerResolved: boolean;
  // The latest snapshot the owner has received, so the catch can
  // terminate children adopted after turn 1. Honest staleness window: the
  // owner sees state at durable turn boundaries, so children dispatched by a
  // turn that crashed mid-flight are absent from this snapshot and escape
  // crash cleanup.
  lastSessionState: DurableSessionState | undefined;
  // The latest context adopted from a completed turn, which carries provider
  // and trace state needed by terminal instrumentation.
  serializedContext: Record<string, unknown>;
  // Whether the session already emitted a terminal protocol and instrumentation
  // event (set here on the crash path, or by the finalization steps via
  // `terminalState`), so later callback or teardown failures cannot contradict it.
  terminalEmitted: boolean;
  // The most recently dispatched turn, derived from the dispatch index so the
  // durable workflow body does not import the harness. Never cleared on settle:
  // a crash between turns is attributed to the last dispatched turn.
  turnId?: string;
}

export function hasDelegatedCallerContext(serializedContext: Record<string, unknown>): boolean {
  if (serializedContext["eve.sessionCallback"] !== undefined) return true;
  const channel = serializedContext["eve.channel"];
  return (
    typeof channel === "object" && channel !== null && Reflect.get(channel, "kind") === "subagent"
  );
}

/**
 * Caller to reject from the crash path. Normally the resolved cell value —
 * including `undefined` after a settled reply cleared it, when there is
 * nothing left to notify. When the crash happened before
 * `resolveInitialTurnCallerStep` ever ran (e.g. `createSessionStep` threw),
 * the cell is empty even though a delegated caller may be parked on this
 * session's reply, so the caller is re-resolved from the serialized context
 * — which needs nothing from the failed steps. Best-effort: when resolution
 * fails again there is no reachable caller to notify.
 */
export async function resolveCallerForCrash(
  state: CrashCleanupState,
  serializedContext: Record<string, unknown>,
): Promise<TurnCaller | undefined> {
  if (state.callerResolved) {
    return state.caller;
  }
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
