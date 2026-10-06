import {
  asSchema,
  type ModelMessage,
  type Telemetry,
  type TelemetryOptions,
  type ToolSet,
  type TypedToolResult,
} from "ai";

import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { isInlineAuthorizationToolResult } from "#harness/inline-tool-authorization.js";
import { toolCallModelOutput } from "#harness/tool-call-io.js";
import { projectDeltaPresentation, projectResultPresentation } from "#harness/tool-presentation.js";
import { recheckApprovedCall, wrapToolExecute } from "#harness/tools.js";
import {
  failedCallResult,
  TOOL_EXECUTION_DENIED_MESSAGE,
  unavailableToolMessage,
} from "#harness/input-request-resolution.js";
import { throwIfTurnAborted } from "#harness/turn-cancellation.js";
import type { HarnessToolLookup } from "#harness/types.js";
import { createActionPartialEvent, createActionResultEvent } from "#protocol/message.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toError } from "#shared/errors.js";
import { createLogger, logError } from "#internal/logging.js";
import type { InputRequest } from "#shared/input.js";
import { parseJsonObject } from "#shared/json.js";
import { toModelSchema } from "#tools/schema.js";
import type { HandleEventFn } from "#harness/types.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export interface ApprovedCallResult {
  readonly part: Extract<ToolResponsePart, { type: "tool-result" }>;
}

const log = createLogger("harness.tool-loop");

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
  readonly settled: readonly ApprovedCallResult[];
  readonly toolResults: readonly TypedToolResult<ToolSet>[];
}> {
  const at = {
    sequence: input.position.sequence,
    stepIndex: input.position.stepIndex,
    turnId: input.position.turnId,
  };
  /** A call that ends without running: the stream reports it failed, and the model reads why. */
  const settleFailure = async (
    callId: string,
    toolName: string,
    message: string,
  ): Promise<ApprovedCallResult> => {
    const failed = failedCallResult(at, { callId, message, toolName });
    await input.publish(failed.event);
    return { part: failed.part };
  };
  const executed = await Promise.allSettled(
    input.requests.map(async (request) => {
      const settled: ApprovedCallResult[] = [];
      const toolResults: TypedToolResult<ToolSet>[] = [];
      const { callId, toolName, input: args } = request.action;
      const definition = input.tools.get(toolName);
      const execute = definition === undefined ? undefined : wrapToolExecute(definition);
      try {
        throwIfTurnAborted(input.abortSignal);
        // A connection or dynamic tool can go away while its call waits for approval.
        if (definition === undefined || execute === undefined) {
          return {
            settled: [await settleFailure(callId, toolName, unavailableToolMessage(toolName))],
            toolResults,
          };
        }
        // As in the AI SDK: the stored input revalidates against the tool's own schema and runs
        // unchanged, so the call that runs is the one the person approved.
        const validation = await asSchema(
          toModelSchema(definition.inputSchema, "input"),
        ).validate?.(args);
        if (validation?.success === false) {
          const message = `The approved input is no longer valid for tool "${toolName}". Request a new tool call and approval.`;
          return { settled: [await settleFailure(callId, toolName, message)], toolResults };
        }
        const recheck = await recheckApprovedCall(definition, {
          abortSignal: input.abortSignal,
          callId,
          input: args,
          approvedTools: input.approvedTools,
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
          return { settled, toolResults };
        }
        let output: unknown;
        let failed = false;
        const telemetry = toolTelemetry(input.telemetry, {
          messages: [...input.messages],
          toolCall: { input: args, toolCallId: callId, toolName, type: "tool-call" },
        });
        await telemetry.started();
        let executionMs = 0;
        try {
          await telemetry.execute(async () => {
            const startedAt = performance.now();
            try {
              const executed = execute(args, {
                abortSignal: input.abortSignal,
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
                      result: createRuntimeToolResultFromValue({
                        callId,
                        output: partial,
                        toolName,
                      }),
                    }),
                  );
                }
              } else {
                output = await executed;
              }
            } finally {
              executionMs = performance.now() - startedAt;
            }
          });
        } catch (error) {
          await telemetry.ended(
            { error, input: args, toolCallId: callId, toolName, type: "tool-error" },
            executionMs,
          );
          throwIfTurnAborted(input.abortSignal);
          logError(log, "tool execution failed", error, { toolName, toolCallId: callId });
          failed = true;
          output = toError(error).message;
        }
        if (!failed) {
          await telemetry.ended(
            { input: args, output, toolCallId: callId, toolName, type: "tool-result" },
            executionMs,
          );
        }
        const result = {
          input: args,
          output,
          toolCallId: callId,
          toolName,
          type: "tool-result",
        } as TypedToolResult<ToolSet>;
        toolResults.push(result);
        if (isInlineAuthorizationToolResult(result)) return { settled, toolResults };
        settled.push({
          part: {
            output: failed
              ? { type: "error-text", value: String(output) }
              : await toolCallModelOutput(definition, output, callId),
            toolCallId: callId,
            toolName,
            type: "tool-result",
          },
        });
        await input.publish(
          createActionResultEvent({
            ...at,
            presentation: failed
              ? undefined
              : projectResultPresentation(definition, callId, parseJsonObject(args), output),
            result: createRuntimeToolResultFromValue({ callId, isError: failed, output, toolName }),
          }),
        );
        return { settled, toolResults };
      } catch (error) {
        throwIfTurnAborted(input.abortSignal);
        logError(log, "approved tool failed", error, { toolName, toolCallId: callId });
        return {
          settled: [await settleFailure(callId, toolName, toError(error).message)],
          toolResults,
        };
      }
    }),
  );
  const failed = executed.find((call) => call.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  const completed = executed.flatMap((call) => (call.status === "fulfilled" ? [call.value] : []));
  return {
    settled: completed.flatMap((call) => call.settled),
    toolResults: completed.flatMap((call) => call.toolResults),
  };
}

type ToolExecutionStart = Parameters<NonNullable<Telemetry["onToolExecutionStart"]>>[0];
type ToolExecutionEnd = Parameters<NonNullable<Telemetry["onToolExecutionEnd"]>>[0];

/**
 * The telemetry around one tool execution, as the AI SDK dispatches it for an approved call it
 * runs: each integration hears the start and the end, and their `executeTool` wrappers nest
 * around the call so work it does is attributed to it. Integration failures don't fail the call.
 */
function toolTelemetry(
  telemetry: TelemetryOptions | undefined,
  execution: Pick<ToolExecutionStart, "messages" | "toolCall">,
): {
  readonly started: () => Promise<void>;
  readonly execute: (execute: () => PromiseLike<void>) => Promise<void>;
  readonly ended: (
    toolOutput: ToolExecutionEnd["toolOutput"],
    toolExecutionMs: number,
  ) => Promise<void>;
} {
  const integrations =
    telemetry === undefined || telemetry.isEnabled === false
      ? []
      : [telemetry.integrations ?? []].flat();
  const event = {
    ...execution,
    callId: `approved:${execution.toolCall.toolCallId}`,
    functionId: telemetry?.functionId,
    recordInputs: telemetry?.recordInputs,
    recordOutputs: telemetry?.recordOutputs,
    toolContext: undefined,
  } as ToolExecutionStart;
  const notify = async (callback: (integration: Telemetry) => unknown) => {
    await Promise.allSettled(integrations.map(async (integration) => await callback(integration)));
  };
  return {
    started: () => notify((integration) => integration.onToolExecutionStart?.(event)),
    execute: async (execute) => {
      let wrapped: () => PromiseLike<void> = execute;
      for (const integration of integrations) {
        if (integration.executeTool === undefined) continue;
        const inner = wrapped;
        wrapped = () =>
          integration.executeTool!({
            ...event,
            execute: inner,
            toolCallId: execution.toolCall.toolCallId,
          });
      }
      await wrapped();
    },
    ended: (toolOutput, toolExecutionMs) =>
      notify((integration) =>
        integration.onToolExecutionEnd?.({
          ...event,
          toolExecutionMs,
          toolOutput,
        } as ToolExecutionEnd),
      ),
  };
}
