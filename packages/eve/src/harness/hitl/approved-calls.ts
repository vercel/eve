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
import {
  cancelPromotedTasks,
  withTaskPromotionAllowed,
  type PromotedTaskCall,
} from "#tools/task-handoff.js";

export { APPROVED_CALL_INTERRUPTED_MESSAGE } from "#harness/call-executor.js";

export interface SignInReports {
  readonly report: (call: ApprovedCall, failure?: Error | string) => Promise<void>;
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

export async function runApprovedCalls(input: {
  readonly allowTaskPromotion?: boolean;
  readonly approvals: readonly ApprovedCall[];
  readonly tools: HarnessToolLookup;
  readonly approvalMemory?: ApprovalMemory;
  readonly messages: readonly ModelMessage[];
  readonly publish: HandleEventFn;
  readonly abortSignal: AbortSignal | undefined;
  readonly telemetry?: TelemetryOptions;
  readonly responderOf?: (approval: ApprovedCall) => SessionAuthContext | undefined;
  readonly view: () => Pick<SessionView, "projection">;
  readonly signIns?: SignInReports;
}): Promise<{
  readonly promotedTasks: readonly PromotedTaskCall[];
  readonly settled: readonly CallResult[];
  readonly signIns: readonly ToolSignIn[];
}> {
  const reportSignIns = (input.signIns ?? signInReports(input)).report;
  const executed = await withTaskPromotionAllowed(input.allowTaskPromotion === true, () =>
    Promise.allSettled(
      input.approvals.map(async (approval): Promise<CallOutcome> => {
        const { call } = approval;
        const { callId, toolName } = call;
        const definition = input.tools.get(toolName);
        if (changedSinceOffered(call, definition)) {
          const message = changedToolMessage(toolName);
          const failed = failedCall({ callId, message, toolName });
          await reportSignIns(approval);
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
              beforeResult: ({ failure, invoked }) =>
                reportSignIns(approval, invoked ? failure : undefined),
            },
            "recheck",
          );
        }
        const searchable = input.tools.get(SEARCH_TOOL_NAME) !== undefined;
        const message = unavailableToolMessage(toolName, searchable);
        const failed = failedCall({ callId, message, toolName });
        await reportSignIns(approval);
        await input.publish(settleCall(failed.result));
        return { settled: [{ part: failed.part }], toolResults: [] };
      }),
    ),
  );
  const completed = executed.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  const promotedTasks = completed.flatMap((call) =>
    call.promoted === undefined ? [] : [call.promoted],
  );
  const failed = executed.find((call) => call.status === "rejected");
  if (failed?.status === "rejected" && input.abortSignal?.aborted !== true) {
    await cancelPromotedTasks(promotedTasks);
    throw failed.reason;
  }
  const aborted = input.abortSignal?.aborted === true;
  if (aborted) await cancelPromotedTasks(promotedTasks);
  return {
    promotedTasks: aborted ? [] : promotedTasks,
    settled: completed.flatMap((call) => call.settled),
    signIns: completed.flatMap((call) => (call.signIn === undefined ? [] : [call.signIn])),
  };
}
