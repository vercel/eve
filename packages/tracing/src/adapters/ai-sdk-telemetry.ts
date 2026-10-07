import type { Telemetry } from "ai";
import type { AgentTracing, TurnInput } from "../agent-tracing.js";
import type {
  AttemptOperation,
  ModelOperation,
  ToolOperation,
  TurnOperation,
} from "../operations.js";
import { modelContent, modelUsage } from "./ai-sdk-payload.js";

type Event<K extends keyof Telemetry> = Parameters<NonNullable<Telemetry[K]>>[0];

export interface AiSdkTelemetryOptions {
  /** The turn a generation records. Called once per AI SDK call. */
  readonly turn: TurnInput | ((call: { readonly callId: string }) => TurnInput);
}

interface Generation {
  readonly startTimeMs: number;
  turn?: Promise<TurnOperation>;
  attempt?: Promise<AttemptOperation>;
  model?: Promise<ModelOperation>;
  readonly tools: Map<string, Promise<ToolOperation>>;
}

const ABANDONED = { outcome: "abandoned" } as const;

/**
 * An AI SDK telemetry integration that records each generation as a turn.
 * Pass it to `telemetry.integrations` of `generateText`, `streamText`, or an
 * agent such as `HarnessAgent`.
 */
export function aiSdkTelemetry(tracing: AgentTracing, options: AiSdkTelemetryOptions): Telemetry {
  const generations = new Map<string, Generation>();

  function generation(callId: string): Generation {
    let state = generations.get(callId);
    if (state === undefined) {
      state = { startTimeMs: Date.now(), tools: new Map() };
      generations.set(callId, state);
    }
    return state;
  }

  async function closeStep(state: Generation, failure?: unknown) {
    const result =
      failure === undefined ? ABANDONED : { outcome: "abandoned", failed: true, error: failure };
    await (await state.model)?.complete(result);
    for (const tool of state.tools.values()) await (await tool).complete(result);
    state.model = undefined;
    state.tools.clear();
    const attempt = await state.attempt;
    state.attempt = undefined;
    if (failure === undefined) await attempt?.complete();
    else await attempt?.fail(failure);
  }

  async function finish(
    callId: string,
    end: (turn: TurnOperation) => Promise<void>,
    failure?: unknown,
  ) {
    const state = generations.get(callId);
    generations.delete(callId);
    if (state === undefined) return;
    await closeStep(state, failure);
    const turn = await state.turn;
    if (turn !== undefined) await end(turn);
  }

  return {
    onStart(event: Event<"onStart">) {
      generation(event.callId);
    },
    async onStepStart(event: Event<"onStepStart">) {
      const state = generation(event.callId);
      await closeStep(state);
      state.turn ??= tracing.turn({
        startTimeMs: state.startTimeMs,
        ...(typeof options.turn === "function"
          ? options.turn({ callId: event.callId })
          : options.turn),
      });
      const turn = await state.turn;
      state.attempt = turn.attempt({ stepIndex: event.stepNumber, attempt: 0 });
    },
    async onLanguageModelCallStart(event: Event<"onLanguageModelCallStart">) {
      const attempt = await generations.get(event.callId)?.attempt;
      if (attempt === undefined) return;
      generations.get(event.callId)!.model = attempt.modelCall({
        provider: event.provider,
        modelId: event.modelId,
        messages: event.messages,
        instructions: event.instructions,
        tools: event.tools,
      });
    },
    async executeLanguageModelCall({ callId, execute }) {
      const model = await generations.get(callId)?.model;
      if (model === undefined || model.finished) return execute();
      try {
        return await model.run(execute);
      } catch (error) {
        await model.fail(error);
        throw error;
      }
    },
    async onLanguageModelCallEnd(event: Event<"onLanguageModelCallEnd">) {
      const state = generations.get(event.callId);
      const model = await state?.model;
      if (state === undefined || model === undefined) return;
      state.model = undefined;
      await model.complete({
        outcome: "completed",
        result: {
          finishReason: event.finishReason,
          usage: modelUsage(event.usage),
          responseId: event.responseId,
          responseModelId: event.modelId,
          content: modelContent(event.content),
        },
      });
    },
    async onToolExecutionStart(event: Event<"onToolExecutionStart">) {
      const state = generations.get(event.callId);
      const attempt = await state?.attempt;
      if (state === undefined || attempt === undefined) return;
      const call = event.toolCall;
      state.tools.set(
        call.toolCallId,
        attempt.tool({ callId: call.toolCallId, name: call.toolName, arguments: call.input }),
      );
    },
    async executeTool({ callId, toolCallId, execute }) {
      const tool = await generations.get(callId)?.tools.get(toolCallId);
      return tool === undefined || tool.finished ? execute() : tool.run(execute);
    },
    async onToolExecutionEnd(event: Event<"onToolExecutionEnd">) {
      const state = generations.get(event.callId);
      const tool = await state?.tools.get(event.toolCall.toolCallId);
      if (state === undefined || tool === undefined) return;
      state.tools.delete(event.toolCall.toolCallId);
      const output = event.toolOutput;
      const completion =
        output.type === "tool-error"
          ? {
              outcome: "failed",
              errorType: output.error instanceof Error ? output.error.name : "tool_error",
              error: output.error,
            }
          : { outcome: "completed", output: "output" in output ? output.output : undefined };
      await tool.complete(completion);
    },
    async onStepEnd(event: Event<"onStepEnd">) {
      const state = generations.get(event.callId);
      if (state !== undefined) await closeStep(state);
    },
    async onEnd(event: Event<"onEnd">) {
      await finish(event.callId, (turn) =>
        turn.complete({
          outcome: "completed",
          usage: "totalUsage" in event ? modelUsage(event.totalUsage) : undefined,
        }),
      );
    },
    async onAbort(event: Event<"onAbort">) {
      await finish(event.callId, (turn) => turn.complete({ outcome: "cancelled" }));
    },
    async onError(value: unknown) {
      // Some agents report the bare error; it then belongs to every open call.
      const { callId, error } =
        value !== null && typeof value === "object" && "callId" in value && "error" in value
          ? (value as { callId: string; error: unknown })
          : { callId: undefined, error: value };
      for (const id of callId === undefined ? [...generations.keys()] : [callId])
        await finish(id, (turn) => turn.fail(error), error);
    },
  };
}
