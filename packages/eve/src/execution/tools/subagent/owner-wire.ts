import { findRunningAgentHandle } from "#harness/handles/query.js";
import { findToolRun, isInboxSubagentResultFromRecordedRun } from "#harness/tool-runs.js";
import type { SessionStateMap } from "#harness/types.js";
import type { RunReport } from "#execution/tool-run/messages.js";

/** Binds one ordered relay event to the recorded run and child address. */
export function bindTurnSubagentEvent(
  state: SessionStateMap | undefined,
  report: Extract<RunReport, { kind: "subagent-event" }>,
) {
  const event = report.event;
  if (event.kind !== "subagent-input-request" && event.kind !== "subagent-authorization-event") {
    return undefined;
  }
  const run = findToolRun(state, report.from.callId);
  const handle = findRunningAgentHandle(state, { callId: report.from.callId });
  return run?.resultKind === "subagent" &&
    run.runId === report.from.runId &&
    run.toolName === report.from.toolName &&
    handle?.address.sessionId === event.childSessionId &&
    event.callId === report.from.callId &&
    event.subagentName === report.from.toolName
    ? event
    : undefined;
}

/** Binds an event from a persisted pre-relay child to its running handle. */
export function bindLegacyTurnSubagentEvent(
  state: SessionStateMap | undefined,
  event: Extract<RunReport, { kind: "subagent-event" }>["event"],
) {
  if (event.kind !== "subagent-input-request" && event.kind !== "subagent-authorization-event") {
    return undefined;
  }
  const handle = findRunningAgentHandle(state, { callId: event.callId });
  return handle?.identity.name === event.subagentName &&
    handle.address.sessionId === event.childSessionId
    ? event
    : undefined;
}

/** Binds one ordered relay result to the exact recorded run. */
export function isTurnSubagentOutcomeBound(
  state: SessionStateMap | undefined,
  report: Extract<RunReport, { kind: "subagent-outcome" }>,
): boolean {
  const run = findToolRun(state, report.from.callId);
  return (
    run?.resultKind === "subagent" &&
    run.runId === report.from.runId &&
    run.toolName === report.from.toolName &&
    report.result.callId === report.from.callId &&
    report.result.subagentName === report.from.toolName &&
    isInboxSubagentResultFromRecordedRun(state, report.result)
  );
}
