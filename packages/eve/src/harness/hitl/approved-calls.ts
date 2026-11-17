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

export interface SignInReports {
  readonly report: (call: ApprovedCall, failure?: Error | string) => Promise<void>;
  readonly completed: (signIns: readonly AuthorizationChallenge[]) => SignInCompleted;
}

export function signInFailureOf(failure: unknown): {
  readonly reason: string;
  readonly retryable?: boolean;
} {
  if (!isConnectionAuthorizationFailedError(failure)) return { reason: toErrorMessage(failure) };
  return { reason: failure.reason ?? failure.message, retryable: failure.retryable };
}

export function signInReports(input: {
  readonly publish: HandleEventFn;
  readonly view: () => Pick<SessionView, "projection">;
}): SignInReports {
  const reported = new Map<string, Promise<void>>();
  const settle = async (
    challenge: AuthorizationChallenge,
    failure: Error | string | undefined,
  ): Promise<void> => {
    const events = callSignInsSettled(
      input.view(),
      { signIns: [challenge] },
      failure === undefined ? undefined : signInFailureOf(failure),
    );
    if (events.length > 0) await input.publish(commitOf(events));
  };
  const reportOne = (
    challenge: AuthorizationChallenge,
    failure: Error | string | undefined,
  ): Promise<void> => {
    const key = signInAttemptKey(challenge);
    let pending = reported.get(key);
    if (pending === undefined) {
      pending = settle(challenge, failure);
      reported.set(key, pending);
    }
    return pending;
  };
  return {
    report: async (call, failure) => {
      await Promise.all((call.signIns ?? []).map((challenge) => reportOne(challenge, failure)));
    },
    completed: (signIns) => async (result, failure) => {
      if (result.attemptId === undefined) return;
      const challenge = signIns.find(({ attemptId }) => attemptId === result.attemptId);
      if (challenge !== undefined) await reportOne(challenge, failure);
    },
  };
}

export async function runApprovedCalls(input: {
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
      const searchable = input.tools.get(SEARCH_TOOL_NAME) !== undefined;
      const message = unavailableToolMessage(toolName, searchable);
      const failed = failedCall({ callId, message, toolName });
      await reportSignIns(approval, message);
      await input.publish(settleCall(failed.result));
      return { settled: [{ part: failed.part }], toolResults: [] };
    }),
  );
  const failed = executed.find((call) => call.status === "rejected");
  if (failed?.status === "rejected" && input.abortSignal?.aborted !== true) throw failed.reason;
  const completed = executed.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  return {
    settled: completed.flatMap((call) => call.settled),
    signIns: completed.flatMap((call) => (call.signIn === undefined ? [] : [call.signIn])),
  };
}
