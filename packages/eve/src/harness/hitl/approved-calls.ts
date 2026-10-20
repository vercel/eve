import type { ModelMessage, TelemetryOptions } from "ai";

import type { SessionAuthContext } from "#channel/types.js";

import {
  type CallOutcome,
  executeToolCall,
  type CallResult,
  type ToolSignIn,
} from "#harness/call-executor.js";
import {
  failedCall,
  TOOL_EXECUTION_DENIED_MESSAGE,
  unavailableToolMessage,
} from "#harness/approval-outcome.js";
import { isRunnableTool } from "#harness/tools.js";
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { callSettledFrom } from "#harness/call-facts.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { ApprovedCall } from "#harness/session-machine/state.js";
import { callSignInsSettled } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { toErrorMessage } from "#shared/errors.js";

export { APPROVED_CALL_INTERRUPTED_MESSAGE } from "#harness/call-executor.js";

/**
 * Runs approved local calls before the model reads their results. Like the calls a model step
 * runs inline, each streams its progress and result as it goes. The lifecycle owner places the
 * results in the steps that made the calls.
 */
export async function runApprovedCalls(input: {
  readonly approvals: readonly ApprovedCall[];
  /** The entries of the step that asked, which the approved calls run. */
  readonly tools: HarnessToolLookup;
  readonly approvedTools?: ReadonlySet<string>;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly position: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly publish: HandleEventFn;
  readonly abortSignal: AbortSignal | undefined;
  /** The step attempt's telemetry, which hears each execution as the AI SDK reports it. */
  readonly telemetry?: TelemetryOptions;
  /** Who approved each call, which it reads as `ctx.approval`; it still runs as the requester. */
  readonly responderOf?: (approval: ApprovedCall) => SessionAuthContext | undefined;
  /** The session as of the latest publish, which says whether a call's sign-ins are still open. */
  readonly view: () => Pick<SessionView, "projection">;
}): Promise<{
  readonly settled: readonly CallResult[];
  readonly signIns: readonly ToolSignIn[];
}> {
  /**
   * The sign-ins a call waited on end with the call, once `completeAuthorization` has run in it:
   * accepted if it returned, failed with the reason it didn't. Reported before the call's result.
   */
  const reportSignIns = async (call: ApprovedCall, failure?: Error | string): Promise<void> => {
    if ((call.signIns?.length ?? 0) === 0) return;
    const refused = isConnectionAuthorizationFailedError(failure) ? failure : undefined;
    const events = callSignInsSettled(
      input.view(),
      call,
      failure === undefined
        ? undefined
        : {
            reason:
              refused === undefined ? toErrorMessage(failure) : (refused.reason ?? refused.message),
            ...(refused !== undefined && { retryable: refused.retryable }),
          },
    );
    if (events.length > 0) await input.publish(events);
  };
  const executed = await Promise.allSettled(
    input.approvals.map(async (approval): Promise<CallOutcome> => {
      const { call, interactionId } = approval;
      const { callId, toolName } = call;
      const definition = input.tools.get(toolName);
      if (isRunnableTool(definition)) {
        const responder = input.responderOf?.(approval);
        return await executeToolCall(
          call,
          {
            ...input,
            // A call only a sign-in stopped was never cleared by a person.
            ...(interactionId !== undefined && { clearedBy: { interactionId } }),
            definition,
            ...(responder !== undefined && { responder }),
            beforeResult: (failure) => reportSignIns(approval, failure),
          },
          "recheck",
        );
      }
      // A connection or dynamic tool can go away while its call waits for approval.
      const searchable = input.tools.get(SEARCH_TOOL_NAME) !== undefined;
      const message = unavailableToolMessage(toolName, searchable);
      const failed = failedCall({ callId, message, toolName });
      await reportSignIns(approval, message);
      await input.publish(callSettledFrom(failed.result));
      return { settled: [{ part: failed.part }], toolResults: [] };
    }),
  );
  const failed = executed.find((call) => call.status === "rejected");
  // Only a cancellation rejects a call, and only one that hadn't started: it stays approved. The
  // calls that settled keep their results, and the caller ends the cancelled turn after it
  // records them.
  if (failed?.status === "rejected" && input.abortSignal?.aborted !== true) throw failed.reason;
  const completed = executed.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  return {
    settled: completed.flatMap((call) => call.settled),
    signIns: completed.flatMap((call) => (call.signIn === undefined ? [] : [call.signIn])),
  };
}

/** A local call's result, as an approved call settles. */
export type ApprovedCallResult = CallResult;

/** Records an approved call refused by its final request-policy check. */
export async function rejectApprovedCall(input: {
  readonly approval: ApprovedCall;
  readonly reason?: string;
  readonly position: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly publish: HandleEventFn;
}): Promise<ApprovedCallResult> {
  const { callId, toolName } = input.approval.call;
  await input.publish(
    callSettledFrom(
      {
        callId,
        isError: true,
        kind: "tool-result",
        output: {
          code: "TOOL_EXECUTION_DENIED",
          message: input.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
          tool: { result: "not_run" },
        },
        toolName,
      },
      { rejected: true },
    ),
  );
  return {
    part: {
      output: { reason: input.reason, type: "execution-denied" },
      toolCallId: callId,
      toolName,
      type: "tool-result",
    },
  };
}
