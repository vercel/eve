import type { ModelMessage, ToolResultPart, ToolSet, TypedToolResult } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import type { RequestAt } from "#harness/human-input/index.js";
import {
  findInlineAuthorizationSignals,
  isInlineAuthorizationToolResult,
} from "#harness/inline-tool-authorization.js";
import { emitNestedToolActions } from "#harness/nested-actions.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import { projectDeltaPresentation, projectResultPresentation } from "#harness/tool-presentation.js";
import { buildToolSet, recheckApprovedCall } from "#harness/tools.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HarnessEmitFn, HarnessSession, HarnessToolMap } from "#harness/types.js";
import { collectDeferredCalls } from "#harness/workflow-dispatch.js";
import { createActionPartialEvent, createActionResultEvent } from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { InputRequest } from "#shared/input.js";
import { parseJsonObject } from "#shared/json.js";

/**
 * Runs approved local calls before the model reads their results, with the
 * tools of the step that asked. Like the calls a model step runs inline, each
 * streams its progress and result as it goes. The approval policy runs again
 * first: a call it now refuses doesn't run and reports `rejected`. A call that
 * returns a sign-in gets no result here; `signIns` lists it.
 */
async function runApprovedCalls(input: {
  readonly abortSignal: AbortSignal | undefined;
  /** Where the calls' events sit in the stream: the step that asked. */
  readonly at: { readonly sequence: number; readonly stepIndex: number; readonly turnId: string };
  readonly emit: HarnessEmitFn | undefined;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly results: readonly ToolResultPart[];
  readonly signIns: readonly TypedToolResult<ToolSet>[];
}> {
  const results: ToolResultPart[] = [];
  const signIns: TypedToolResult<ToolSet>[] = [];
  const tools = buildToolSet({ tools: input.tools });
  const emit = input.emit ?? (async () => {});
  const { at } = input;
  for (const request of input.requests) {
    const { callId, toolName, input: args } = request.action;
    const definition = input.tools.get(toolName);
    const tool = tools[toolName];
    if (definition?.execute === undefined || tool?.execute === undefined) continue;
    throwIfTurnAborted(input.abortSignal);
    const recheck = await recheckApprovedCall(definition, {
      abortSignal: input.abortSignal,
      callId,
      input: args,
    });
    if (recheck.denied) {
      const reason = recheck.reason ?? "Tool execution was denied.";
      await emit(
        createActionResultEvent({
          ...at,
          rejected: true,
          result: {
            callId,
            isError: true,
            kind: "tool-result",
            output: { code: "TOOL_EXECUTION_DENIED", message: reason, tool: { result: "not_run" } },
            toolName,
          },
        }),
      );
      results.push({
        output: { reason, type: "execution-denied" },
        toolCallId: callId,
        toolName,
        type: "tool-result",
      });
      continue;
    }
    let output: unknown;
    let failed = false;
    try {
      const executed = tool.execute(args, {
        abortSignal: input.abortSignal,
        context: undefined,
        messages: [...input.messages],
        toolCallId: callId,
      });
      if (isAsyncIterable(executed)) {
        for await (const partial of executed) {
          output = partial;
          await emit(
            createActionPartialEvent({
              ...at,
              presentation: projectDeltaPresentation(
                definition,
                callId,
                parseJsonObject(args),
                partial,
              ),
              result: createRuntimeToolResultFromValue({ callId, output: partial, toolName }),
            }),
          );
        }
      } else {
        output = await executed;
      }
    } catch (error) {
      throwIfTurnAborted(input.abortSignal);
      failed = true;
      output = toError(error).message;
    }
    const result = {
      input: args,
      output,
      toolCallId: callId,
      toolName,
      type: "tool-result",
    } as TypedToolResult<ToolSet>;
    if (isInlineAuthorizationToolResult(result)) {
      signIns.push(result);
      continue;
    }
    // Calls the tool made on the model's behalf report before its result.
    await emitNestedToolActions(emit, at, callId);
    await emit(
      createActionResultEvent({
        ...at,
        presentation: failed
          ? undefined
          : projectResultPresentation(definition, callId, parseJsonObject(args), output),
        result: createRuntimeToolResultFromValue({ callId, isError: failed, output, toolName }),
      }),
    );
    results.push({
      output: failed
        ? { type: "error-text", value: String(output) }
        : tool.toModelOutput === undefined
          ? normalizeToolModelOutput({
              output: { type: "json", value: (output ?? null) as never },
              toolCallId: callId,
              toolName,
            })
          : await tool.toModelOutput({ input: args, output, toolCallId: callId }),
      toolCallId: callId,
      toolName,
      type: "tool-result",
    });
  }
  return { results, signIns };
}

/** Approved calls that run as runtime work: the step parks on them as a coordination batch. */
export interface ApprovedRuntimeCalls {
  readonly at: RequestAt;
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
}

/** What running approved calls left for the applier to report or park on. */
export interface ApprovedWork {
  readonly results: readonly ToolResultPart[];
  readonly runtimeCalls?: ApprovedRuntimeCalls;
  readonly session: HarnessSession;
  readonly signIns?: ReturnType<typeof findInlineAuthorizationSignals>;
}

/**
 * Runs the calls a person approved, with the tools of the step that asked:
 * local calls run now, and workflow calls become runtime work the step parks on.
 */
export async function runApprovedWork(input: {
  readonly abortSignal: AbortSignal | undefined;
  readonly at: RequestAt;
  readonly emit: HarnessEmitFn | undefined;
  readonly messages: readonly ModelMessage[];
  readonly requests: readonly InputRequest[];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<ApprovedWork> {
  const { at, session, tools } = input;
  for (const request of input.requests) {
    if (!tools.has(request.action.toolName)) {
      throw new Error(
        "The approved tool is no longer available. Request a new tool call and approval.",
      );
    }
  }
  const runsInRuntime = (request: InputRequest) =>
    tools.get(request.action.toolName)?.workflowId !== undefined;
  const local = await runApprovedCalls({
    abortSignal: input.abortSignal,
    at,
    emit: input.emit,
    messages: input.messages,
    requests: input.requests.filter((request) => !runsInRuntime(request)),
    tools,
  });
  const runtime = input.requests.filter(runsInRuntime);
  const deferred =
    runtime.length === 0
      ? undefined
      : collectDeferredCalls({
          session,
          toolCalls: runtime.map(({ action }) => ({
            input: action.input,
            toolCallId: action.callId,
            toolName: action.toolName,
          })),
          tools,
          turnId: at.turnId,
        });
  return {
    results: local.results,
    runtimeCalls: deferred === undefined ? undefined : { at, tasks: deferred.workflowRequests },
    session: deferred?.session ?? session,
    signIns: findInlineAuthorizationSignals(local.signIns),
  };
}
