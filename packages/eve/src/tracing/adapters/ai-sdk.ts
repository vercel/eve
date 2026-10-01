import type { Telemetry, TelemetryOptions } from "ai";
import type { TraceOperation } from "#tracing/core/engine.js";
import type { TurnScope } from "#tracing/core/agent-tracing.js";
import type { ContentPart } from "#tracing/core/types.js";
import { usageAttributes } from "#tracing/core/attributes.js";
import { readGatewayCost } from "#tracing/agent-otel-usage.js";

type Event<K extends keyof Telemetry> = Parameters<NonNullable<Telemetry[K]>>[0];

/** Each SDK invocation owns its correlation state, including physical retries. */
export function aiSdkTracing(
  turn: TurnScope,
  options: { readonly integrations?: readonly Telemetry[] } = {},
): TelemetryOptions {
  const operations = turn.operations;
  const callIndex = turn.nextStep();
  let index = callIndex;
  let modelIndex = 0;
  let step: TraceOperation | undefined;
  const models = new Map<string, TraceOperation>();
  const modelStarts = new Map<string, Event<"onLanguageModelCallStart">>();
  const tools = new Map<string, { action: TraceOperation; tool: TraceOperation }>();
  function own(operation: TraceOperation): TraceOperation {
    turn.own(operation);
    return operation;
  }
  function key(suffix: string): string {
    return `${turn.identity.turnId}:${callIndex}:${index}:${suffix}`;
  }
  function drain(error?: unknown): void {
    for (const operation of models.values()) {
      if (error !== undefined) operation.fail(error);
      operation.end();
    }
    for (const { action, tool } of tools.values()) {
      if (error !== undefined) {
        tool.fail(error);
        action.fail(error);
      }
      action.setAttribute("agent.action.outcome", error === undefined ? "abandoned" : "failed");
      tool.end();
      action.end();
    }
    models.clear();
    modelStarts.clear();
    tools.clear();
    if (step !== undefined && !step.finished) {
      if (error !== undefined) step.fail(error);
      step.addEvent(error === undefined ? "step.completed" : "step.failed");
      step.end();
    }
  }
  function startModel(event: Event<"onLanguageModelCallStart">): TraceOperation | undefined {
    if (step === undefined || step.finished) return undefined;
    const operation = own(
      operations.model(step, {
        operationId: key(`model:${modelIndex++}`),
        provider: event.provider,
        modelId: event.modelId,
        messages: turn.capture.recordInputs ? event.messages : undefined,
        instructions: turn.capture.recordInputs ? event.instructions : undefined,
      }),
    );
    models.set(event.callId, operation);
    return operation;
  }
  const integration: Telemetry = {
    onStepStart() {
      if (step !== undefined) {
        drain();
        index = turn.nextStep();
      }
      step = own(operations.step(turn.activation, { operationId: key("step"), index, attempt: 0 }));
    },
    onLanguageModelCallStart(event) {
      modelStarts.set(event.callId, event);
      startModel(event);
    },
    async executeLanguageModelCall({ callId, execute }) {
      let operation = models.get(callId);
      if (operation === undefined) {
        const start = modelStarts.get(callId);
        if (start !== undefined) operation = startModel(start);
      }
      try {
        return await (operation === undefined ? execute() : operation.run(execute));
      } catch (error) {
        models.delete(callId);
        operation?.fail(error);
        operation?.end();
        throw error;
      }
    },
    onLanguageModelCallEnd(event) {
      const operation = models.get(event.callId);
      models.delete(event.callId);
      modelStarts.delete(event.callId);
      if (operation === undefined || operation.finished) return;
      const usage = {
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        inputTokenDetails: {
          cacheReadTokens: event.usage.inputTokenDetails?.cacheReadTokens,
          cacheWriteTokens: event.usage.inputTokenDetails?.cacheWriteTokens,
        },
      };
      operations.completeModel(operation, {
        usage,
        responseId: event.responseId,
        responseModelId: event.modelId,
        finishReason: event.finishReason,
        content: turn.capture.recordOutputs ? contentParts(event.content) : undefined,
      });
      if (step !== undefined) operations.engine.annotate(step, usageAttributes(usage));
      turn.addUsage(usage.inputTokens, usage.outputTokens);
    },
    onToolExecutionStart(event) {
      if (step === undefined || step.finished) return;
      const call = event.toolCall;
      const action = own(
        operations.action(step, {
          operationId: key(`action:${call.toolCallId}`),
          callId: call.toolCallId,
          name: call.toolName,
          kind: "tool-call",
          stepIndex: index,
          attempt: 0,
          arguments: call.input,
        }),
      );
      const tool = own(
        operations.tool(action, {
          operationId: key(`tool:${call.toolCallId}`),
          callId: call.toolCallId,
          name: call.toolName,
          arguments: call.input,
        }),
      );
      tools.set(call.toolCallId, { action, tool });
    },
    executeTool({ toolCallId, execute }) {
      const active = tools.get(toolCallId)?.tool;
      return active === undefined ? execute() : active.run(execute);
    },
    onToolExecutionEnd(event) {
      const active = tools.get(event.toolCall.toolCallId);
      tools.delete(event.toolCall.toolCallId);
      if (active === undefined) return;
      if (event.toolOutput.type === "tool-result") {
        operations.completeTool(active.tool, { type: "result", output: event.toolOutput.output });
        operations.completeAction(active.action, {
          outcome: "completed",
          output: event.toolOutput.output,
        });
      } else {
        operations.completeTool(active.tool, { type: "error", error: event.toolOutput.error });
        operations.completeAction(active.action, {
          outcome: "failed",
          error: event.toolOutput.error,
        });
      }
    },
    onStepEnd(event) {
      const cost =
        event.providerMetadata === undefined ? undefined : readGatewayCost(event.providerMetadata);
      if (cost !== undefined && step !== undefined) operations.engine.annotate(step, cost);
      drain();
    },
    onAbort() {
      turn.cancel();
      drain();
    },
    onError(event) {
      drain((event as { error: unknown }).error);
    },
    onEnd() {
      drain();
    },
  };
  return {
    isEnabled: true,
    recordInputs: turn.capture.recordInputs,
    recordOutputs: turn.capture.recordOutputs,
    functionId: turn.agentName,
    integrations: [integration, ...(options.integrations ?? [])],
  };
}

function contentParts(content: Event<"onLanguageModelCallEnd">["content"]): readonly ContentPart[] {
  return content.flatMap((part): ContentPart[] => {
    switch (part.type) {
      case "text":
      case "reasoning":
        return [{ type: part.type, text: part.text }];
      case "tool-call":
        return [
          {
            type: "tool-call",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          },
        ];
      case "tool-result":
        return [
          {
            type: "tool-result",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: part.output,
          },
        ];
      case "tool-error":
        return [
          {
            type: "tool-error",
            callId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            error: part.error,
          },
        ];
      default:
        return [];
    }
  });
}
