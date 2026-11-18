import { context, trace, ProxyTracerProvider, createContextKey } from "@opentelemetry/api";
import { registerOTel } from "@vercel/otel";
import { intersectCapture } from "../core/activation.js";
import { runTelemetry } from "../core/run-telemetry.js";
import type { RunIdentity } from "../core/types.js";
import type { Operation } from "../operations.js";
import { aiSdkOpenTelemetry } from "./ai-sdk-otel.js";
import type { Telemetry } from "ai";
import type { AgentRun, TurnInput } from "../agent-run.js";
import type {
  AttemptOperation,
  ModelOperation,
  ToolOperation,
  TurnOperation,
} from "../operations.js";
import { modelContent, modelUsage } from "./ai-sdk-payload.js";

type Event<K extends keyof Telemetry & `on${string}`> = Parameters<NonNullable<Telemetry[K]>>[0];

/** Options for `aiSdkTelemetry`. */
export interface AiSdkTelemetryOptions {
  /** Optional identity, capture, and placement overrides. Called once per AI SDK call. */
  readonly turn?: AiSdkTurnInput | ((call: { readonly callId: string }) => AiSdkTurnInput);
}

/** Turn overrides; omitted IDs are generated for each call. */
export type AiSdkTurnInput = Partial<Omit<TurnInput, "identity">> & {
  readonly identity?: Partial<RunIdentity>;
};

interface ActiveGeneration {
  readonly identity: RunIdentity;
  readonly operation: Operation;
  readonly toolCallId?: string;
}
const ACTIVE_GENERATION = createContextKey("agent.tracing.ai-sdk.generation");
const METADATA_ONLY = { emit: true, recordInputs: false, recordOutputs: false };

interface Generation {
  readonly identity: RunIdentity;
  readonly turn: Promise<TurnOperation>;
  attempt?: Promise<AttemptOperation>;
  model?: Promise<ModelOperation>;
  readonly tools: Map<string, Promise<ToolOperation>>;
}

const ABANDONED = { outcome: "abandoned" } as const;

/** Reuses the run's telemetry for SDK turns and initializes the default OTel provider when needed. */
export function aiSdkTelemetry(run: AgentRun, options: AiSdkTelemetryOptions = {}): Telemetry {
  const backend = runTelemetry.get(run);
  const provider = trace.getTracerProvider();
  if (
    backend?.usesGlobalProvider &&
    provider instanceof ProxyTracerProvider &&
    provider.getDelegateTracer("agent.tracing") === undefined
  )
    registerOTel({ serviceName: "agent-runs", instrumentations: [] });
  const native = aiSdkOpenTelemetry();
  const generations = new Map<string, Generation>();

  function executeInGeneration<T>(
    state: Generation,
    operation: Operation,
    execute: () => T,
    toolCallId?: string,
  ): T {
    const active: ActiveGeneration = { identity: state.identity, operation, toolCallId };
    return operation.run(() =>
      context.with(context.active().setValue(ACTIVE_GENERATION, active), execute),
    );
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
    await end(await state.turn);
  }

  return {
    onObjectStepStart: native.telemetry.onObjectStepStart.bind(native.telemetry),
    onObjectStepEnd: native.telemetry.onObjectStepEnd.bind(native.telemetry),
    onEmbedStart: native.telemetry.onEmbedStart.bind(native.telemetry),
    onEmbedEnd: native.telemetry.onEmbedEnd.bind(native.telemetry),
    onRerankStart: native.telemetry.onRerankStart.bind(native.telemetry),
    onRerankEnd: native.telemetry.onRerankEnd.bind(native.telemetry),
    experimental_onDecideStart: native.telemetry.experimental_onDecideStart.bind(native.telemetry),
    experimental_onDecideEnd: native.telemetry.experimental_onDecideEnd.bind(native.telemetry),
    experimental_onDecisionModelCallStart:
      native.telemetry.experimental_onDecisionModelCallStart.bind(native.telemetry),
    experimental_onDecisionModelCallEnd: native.telemetry.experimental_onDecisionModelCallEnd.bind(
      native.telemetry,
    ),
    experimental_onStreamTranscriptionStart:
      native.telemetry.experimental_onStreamTranscriptionStart.bind(native.telemetry),
    experimental_onStreamTranscriptionEnd:
      native.telemetry.experimental_onStreamTranscriptionEnd.bind(native.telemetry),
    async onStart(event: Event<"onStart">) {
      if (!["ai.generateText", "ai.streamText", "ai.harness"].includes(event.operationId)) {
        native.telemetry.onStart({ ...event, recordInputs: false, recordOutputs: false });
        return;
      }
      const inherited = context.active().getValue(ACTIVE_GENERATION) as
        | ActiveGeneration
        | undefined;
      const active = backend?.telemetry.active();
      const overrides =
        typeof options.turn === "function" ? options.turn({ callId: event.callId }) : options.turn;
      const identity = {
        conversationId: inherited?.identity.conversationId ?? event.callId,
        runId: event.callId,
        turnId: event.callId,
        ...overrides?.identity,
      };
      const owner = inherited?.operation.reference ?? active?.reference;
      const host = backend?.telemetry.activeSpan?.();
      const parent =
        owner === undefined || host?.traceId === owner.traceId ? (host ?? owner) : owner;
      const capture = intersectCapture(
        intersectCapture(
          intersectCapture(overrides?.capture ?? METADATA_ONLY, inherited?.operation.capture),
          active?.capture,
        ),
        {
          emit: true,
          recordInputs: event.recordInputs !== false,
          recordOutputs: event.recordOutputs !== false,
        },
      );
      const state: Generation = {
        identity,
        tools: new Map(),
        turn: run.turn({
          sequence: 0,
          agentName: event.functionId,
          framework: { name: "ai-sdk", version: event.aiVersion },
          context: context.active(),
          parent,
          lineage:
            inherited === undefined
              ? undefined
              : {
                  parentRunId: inherited.identity.runId,
                  parentCallId: inherited.toolCallId,
                  agentName: overrides?.agentName ?? event.functionId,
                },
          ...overrides,
          identity,
          capture,
        }),
      };
      generations.set(event.callId, state);
      const turn = await state.turn;
      native.instrument(turn, () =>
        native.telemetry.onStart({ ...event, recordInputs: false, recordOutputs: false }),
      );
    },
    async onStepStart(event: Event<"onStepStart">) {
      const state = generations.get(event.callId);
      if (state === undefined) return;
      await closeStep(state);
      const turn = await state.turn;
      state.attempt = turn.attempt({ stepIndex: event.stepNumber, attempt: 0 });
      native.instrument(await state.attempt, () => native.telemetry.onStepStart(event));
    },
    async onLanguageModelCallStart(event: Event<"onLanguageModelCallStart">) {
      const attempt = await generations.get(event.callId)?.attempt;
      if (attempt === undefined) return;
      const state = generations.get(event.callId)!;
      state.model = attempt.modelCall({
        provider: event.provider,
        modelId: event.modelId,
        messages: event.messages,
        instructions: event.instructions,
        tools: event.tools,
      });
      native.instrument(await state.model, () => native.telemetry.onLanguageModelCallStart(event));
    },
    async executeLanguageModelCall(event) {
      const state = generations.get(event.callId);
      const model = await state?.model;
      if (state === undefined || model === undefined || model.finished) return event.execute();
      return native.telemetry.executeLanguageModelCall({
        ...event,
        execute: () => executeInGeneration(state, model, event.execute),
      });
    },
    async onLanguageModelCallEnd(event: Event<"onLanguageModelCallEnd">) {
      const state = generations.get(event.callId);
      const model = await state?.model;
      if (state === undefined || model === undefined) return;
      native.withoutNewSpans(() => native.telemetry.onLanguageModelCallEnd(event));
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
      native.instrument(await state.tools.get(call.toolCallId)!, () =>
        native.telemetry.onToolExecutionStart(event),
      );
    },
    async executeTool(event) {
      const state = generations.get(event.callId);
      const tool = await state?.tools.get(event.toolCallId);
      if (state === undefined || tool === undefined || tool.finished) return event.execute();
      return native.telemetry.executeTool({
        ...event,
        execute: () => executeInGeneration(state, tool, event.execute, event.toolCallId),
      });
    },
    async onToolExecutionEnd(event: Event<"onToolExecutionEnd">) {
      const state = generations.get(event.callId);
      const tool = await state?.tools.get(event.toolCall.toolCallId);
      if (state === undefined || tool === undefined) return;
      native.telemetry.onToolExecutionEnd(event);
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
      native.telemetry.onStepEnd(event);
      if (state !== undefined) await closeStep(state);
    },
    async onEnd(event: Event<"onEnd">) {
      native.telemetry.onEnd("totalUsage" in event ? { ...event, usage: event.totalUsage } : event);
      await finish(event.callId, (turn) =>
        turn.complete({
          outcome: "completed",
          usage: "totalUsage" in event ? modelUsage(event.totalUsage) : undefined,
        }),
      );
    },
    async onAbort(event: Event<"onAbort">) {
      native.telemetry.onAbort(event);
      await finish(event.callId, (turn) => turn.complete({ outcome: "cancelled" }));
    },
    async onError(value: unknown) {
      native.telemetry.onError(value);
      const { callId, error } =
        value !== null && typeof value === "object" && "callId" in value && "error" in value
          ? (value as { callId: string; error: unknown })
          : { callId: undefined, error: value };
      if (callId !== undefined) await finish(callId, (turn) => turn.fail(error), error);
    },
  };
}
