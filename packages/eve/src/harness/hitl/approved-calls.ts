import type { ApprovalMemory } from "#approval/evaluation.js";
import type { ModelMessage, TelemetryOptions } from "ai";

import type { SessionAuthContext } from "#channel/types.js";

import {
  type CallOutcome,
  executeToolCall,
  type CallResult,
  type ToolSignIn,
} from "#harness/call-executor.js";
import {
  changedSinceOffered,
  changedToolMessage,
  failedCall,
  unavailableToolMessage,
} from "#harness/approval-outcome.js";
import { isRunnableTool } from "#harness/tools.js";
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { settleCall } from "#harness/session-machine/calls.js";
import { commitOf } from "#harness/session-machine/commit.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import type { ApprovedCall } from "#harness/session-machine/state.js";
import { callSignInsSettled } from "#harness/session-machine/transitions.js";
import type { SessionView } from "#harness/session-machine/view.js";
import { toErrorMessage } from "#shared/errors.js";
import type { AuthorizationChallenge, SignInCompleted } from "#harness/authorization.js";
import { signInAttemptKey } from "#harness/hitl/sign-ins.js";

export { APPROVED_CALL_INTERRUPTED_MESSAGE } from "#harness/call-executor.js";

/**
 * How the sign-ins a batch of resumed calls waited on are reported. A call that completes a sign-in
 * reports it then (`completed`, read through `SignInCompletedKey`), so the other askers for the
 * same grant resume while the call still runs; the call's end reports what is left (`report`):
 * accepted if it returned, failed with the reason it didn't. Each attempt is reported once, by
 * whichever comes first, however many calls complete it at the same time.
 */
export interface SignInReports {
  readonly report: (call: ApprovedCall, failure?: Error | string) => Promise<void>;
  /** The reporter for `SignInCompletedKey` while `calls` run: each attempt with the call it stopped. */
  readonly completed: (calls: readonly ApprovedCall[]) => SignInCompleted;
}

export function signInReports(input: {
  readonly publish: HandleEventFn;
  readonly view: () => Pick<SessionView, "projection">;
}): SignInReports {
  const reported = new Map<string, Promise<void>>();
  const settle = async (
    call: ApprovedCall,
    challenge: AuthorizationChallenge,
    failure: Error | string | undefined,
  ): Promise<void> => {
    const refused = isConnectionAuthorizationFailedError(failure) ? failure : undefined;
    const events = callSignInsSettled(
      input.view(),
      { ...call, signIns: [challenge] },
      failure === undefined
        ? undefined
        : {
            reason:
              refused === undefined ? toErrorMessage(failure) : (refused.reason ?? refused.message),
            ...(refused !== undefined && { retryable: refused.retryable }),
          },
    );
    if (events.length > 0) await input.publish(commitOf(events));
  };
  const reportOne = (
    call: ApprovedCall,
    challenge: AuthorizationChallenge,
    failure: Error | string | undefined,
  ): Promise<void> => {
    const key = signInAttemptKey(challenge);
    let pending = reported.get(key);
    if (pending === undefined) {
      pending = settle(call, challenge, failure);
      reported.set(key, pending);
    }
    return pending;
  };
  return {
    report: async (call, failure) => {
      await Promise.all(
        (call.signIns ?? []).map((challenge) => reportOne(call, challenge, failure)),
      );
    },
    completed: (calls) => async (result, failure) => {
      if (result.attemptId === undefined) return;
      for (const call of calls) {
        const challenge = call.signIns?.find(({ attemptId }) => attemptId === result.attemptId);
        if (challenge !== undefined) await reportOne(call, challenge, failure);
      }
    },
  };
}

/**
 * Runs approved local calls before the model reads their results. Like the calls a model step
 * runs inline, each streams its progress and result as it goes. The lifecycle owner places the
 * results in the steps that made the calls.
 */
export async function runApprovedCalls(input: {
  readonly approvals: readonly ApprovedCall[];
  /** The entries of the step that asked, which the approved calls run. */
  readonly tools: HarnessToolLookup;
  readonly approvalMemory?: ApprovalMemory;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly publish: HandleEventFn;
  readonly abortSignal: AbortSignal | undefined;
  /** The step attempt's telemetry, which hears each execution as the AI SDK reports it. */
  readonly telemetry?: TelemetryOptions;
  /** Who approved each call, which it reads as `ctx.approval`; it still runs as the requester. */
  readonly responderOf?: (approval: ApprovedCall) => SessionAuthContext | undefined;
  /** The session as of the latest publish, which says whether a call's sign-ins are still open. */
  readonly view: () => Pick<SessionView, "projection">;
  /** The batch's sign-in reports, shared by every group of calls resumed together. */
  readonly signIns?: SignInReports;
  /** The agent's tool output budget in bytes; unset when it has none. */
  readonly toolOutputBytes?: number;
}): Promise<{
  readonly settled: readonly CallResult[];
  readonly signIns: readonly ToolSignIn[];
}> {
  const reportSignIns = (input.signIns ?? signInReports(input)).report;
  const executed = await Promise.allSettled(
    input.approvals.map(async (approval): Promise<CallOutcome> => {
      const { call } = approval;
      const { callId, toolName } = call;
      const definition = input.tools.get(toolName);
      if (changedSinceOffered(call, definition)) {
        const message = changedToolMessage(toolName);
        const failed = failedCall({ callId, message, toolName });
        await reportSignIns(approval, message);
        await input.publish(settleCall(failed.result));
        return { settled: [{ part: failed.part }], toolResults: [] };
      }
      if (isRunnableTool(definition)) {
        const responder = input.responderOf?.(approval);
        return await executeToolCall(
          call,
          {
            ...input,
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
      await input.publish(settleCall(failed.result));
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
