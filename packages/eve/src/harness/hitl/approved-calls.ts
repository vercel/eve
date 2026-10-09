import type { ModelMessage, TelemetryOptions } from "ai";

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
} from "#harness/input-request-resolution.js";
import { isRunnableTool } from "#harness/tools.js";
import type { HandleEventFn, HarnessToolLookup } from "#harness/types.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { createActionResultEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

export { APPROVED_CALL_INTERRUPTED_MESSAGE } from "#harness/call-executor.js";

/**
 * Runs approved local calls before the model reads their results. Like the calls a model step
 * runs inline, each streams its progress and result as it goes. The lifecycle owner places the
 * results in the steps that made the calls.
 */
export async function runApprovedCalls(input: {
  readonly requests: readonly InputRequest[];
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
}): Promise<{
  readonly settled: readonly CallResult[];
  readonly signIns: readonly ToolSignIn[];
}> {
  const executed = await Promise.allSettled(
    input.requests.map(async (request): Promise<CallOutcome> => {
      const { callId, toolName } = request.action;
      const definition = input.tools.get(toolName);
      if (isRunnableTool(definition)) {
        return await executeToolCall(request.action, { ...input, definition }, "recheck");
      }
      // A connection or dynamic tool can go away while its call waits for approval.
      const searchable = input.tools.get(SEARCH_TOOL_NAME) !== undefined;
      const failed = failedCall({
        callId,
        message: unavailableToolMessage(toolName, searchable),
        toolName,
      });
      await input.publish(createActionResultEvent({ ...input.position, result: failed.result }));
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
  readonly request: InputRequest;
  readonly reason?: string;
  readonly position: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly publish: HandleEventFn;
}): Promise<ApprovedCallResult> {
  const { callId, toolName } = input.request.action;
  await input.publish(
    createActionResultEvent({
      ...input.position,
      rejected: true,
      result: {
        callId,
        isError: true,
        kind: "tool-result",
        toolName,
        output: {
          code: "TOOL_EXECUTION_DENIED",
          message: input.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
          tool: { result: "not_run" },
        },
      },
    }),
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
