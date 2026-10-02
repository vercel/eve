import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { isInlineAuthorizationToolResult } from "#harness/inline-tool-authorization.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import { projectDeltaPresentation, projectResultPresentation } from "#harness/tool-presentation.js";
import { buildToolSet, recheckApprovedCall } from "#harness/tools.js";
import { TOOL_EXECUTION_DENIED_MESSAGE } from "#harness/input-request-resolution.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HarnessToolMap } from "#harness/types.js";
import { emitNestedToolActions } from "#harness/nested-actions.js";
import { createActionPartialEvent, createActionResultEvent } from "#protocol/message.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import type { InputRequest } from "#shared/input.js";
import { parseJsonObject } from "#shared/json.js";
import type { Publish } from "#harness/session-machine/commit.js";
import type { SettledCall } from "#harness/session-machine/transitions.js";
import type { TurnPosition } from "#harness/session-machine/view.js";

/**
 * Runs approved local calls before the model reads their results. Like the calls a model step
 * runs inline, each streams its progress and result as it goes; `settle` then places the
 * results in the steps that made the calls.
 */
export async function runApprovedCalls(input: {
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly position: TurnPosition;
  readonly publish: Publish;
  readonly abortSignal: AbortSignal | undefined;
}): Promise<{
  readonly settled: readonly SettledCall[];
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
}> {
  const settled: SettledCall[] = [];
  const toolResults: TypedToolResult<ToolSet>[] = [];
  const tools = buildToolSet({ tools: input.tools });
  const at = {
    sequence: input.position.sequence,
    stepIndex: input.position.stepIndex,
    turnId: input.position.turnId,
  };
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
      // The policy refused the call it approved earlier, so it doesn't run.
      await input.publish(
        createActionResultEvent({
          ...at,
          rejected: true,
          result: {
            callId,
            isError: true,
            kind: "tool-result",
            output: {
              code: "TOOL_EXECUTION_DENIED",
              message: recheck.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
              tool: { result: "not_run" },
            },
            toolName,
          },
        }),
      );
      settled.push({
        part: {
          output: { reason: recheck.reason, type: "execution-denied" },
          toolCallId: callId,
          toolName,
          type: "tool-result",
        },
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
          await input.publish(
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
    toolResults.push(result);
    if (isInlineAuthorizationToolResult(result)) continue;
    // Calls the tool made on the model's behalf report before its result.
    await emitNestedToolActions(input.publish, input.position, callId);
    await input.publish(
      createActionResultEvent({
        ...at,
        presentation: failed
          ? undefined
          : projectResultPresentation(definition, callId, parseJsonObject(args), output),
        result: createRuntimeToolResultFromValue({ callId, isError: failed, output, toolName }),
      }),
    );
    settled.push({
      part: {
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
      },
    });
  }
  return { settled, toolResults };
}
