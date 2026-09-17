import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import {
  getWorkflowInvocations,
  findTurnInvocation,
  removeTurnInvocations,
  type TurnWorkflowInvocation,
} from "#harness/workflow-invocations.js";

export function getWorkflowToolRuns(
  state: SessionStateMap | undefined,
  turnId?: string,
): readonly TurnWorkflowInvocation[] {
  return getWorkflowInvocations(state).filter(
    (entry): entry is TurnWorkflowInvocation =>
      entry.lifetime === "turn" && (turnId === undefined || entry.origin.turnId === turnId),
  );
}
/** Results without an originating turn may bind only when exactly one recorded turn owns the call. */
export function findWorkflowToolRun(
  state: SessionStateMap | undefined,
  callId: string,
  turnId?: string,
): TurnWorkflowInvocation | undefined {
  if (turnId !== undefined) return findTurnInvocation(state, turnId, callId);
  const candidates = getWorkflowToolRuns(state).filter((entry) => entry.callId === callId);
  return candidates.length === 1 ? candidates[0] : undefined;
}
export function removeWorkflowToolRun<T extends { readonly state?: SessionStateMap }>(
  session: T,
  callId: string,
  turnId: string,
): T {
  return removeTurnInvocations(session, turnId, callId);
}
export function clearWorkflowToolRuns(session: HarnessSession, turnId: string): HarnessSession {
  return removeTurnInvocations(session, turnId);
}

/** The turn inbox is shared; a result settles a call only if the turn recorded that run. */
export function isInboxToolResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: RuntimeToolResultActionResult,
): boolean {
  const record = findWorkflowToolRun(state, result.callId);
  return (
    record !== undefined && record.resultKind !== "subagent" && record.toolName === result.toolName
  );
}

/** A child result reported through a shared subagent execute run. */
export function isInboxSubagentResultFromRecordedWorkflowToolRun(
  state: SessionStateMap | undefined,
  result: { readonly callId: string; readonly subagentName: string },
): boolean {
  const record = findWorkflowToolRun(state, result.callId);
  return record?.resultKind === "subagent" && record.toolName === result.subagentName;
}
