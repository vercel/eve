import type { Telemetry } from "ai";

import type {
  InstrumentationAttemptScope,
  InstrumentationStepAttemptStartedEvent,
  InstrumentationContentPart,
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationOperationRef,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolOutput,
  InstrumentationUsage,
} from "#instrumentation/lifecycle.js";
import {
  attemptIdempotencyKey,
  modelCallIdempotencyKey,
  toolCallIdempotencyKey,
} from "#instrumentation/lifecycle.js";
import { structuralProviderMetadata } from "#instrumentation/content.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

interface AttemptState {
  readonly capturesInputs: boolean;
  readonly capturesOutputs: boolean;
  readonly modelKeys: Map<string, string>;
  readonly runtimeContext?: Readonly<Record<string, unknown>>;
  readonly scope: InstrumentationAttemptScope;
  readonly toolKeys: Map<string, string>;
  operation?: InstrumentationOperationRef;
  // Only the number is kept: it disambiguates call identities within an attempt.
  stepNumber?: number;
}

/** Creates one provider-neutral AI SDK bridge for one actual model attempt. */
export function createAiSdkHookBridge(
  scope: InstrumentationAttemptScope,
  hooks: InstrumentationHooks,
  runInContext: InstrumentationContextRunner = directRunInContext,
  runtimeContext?: Readonly<Record<string, unknown>>,
): Telemetry {
  const providerHooks = hooks;
  const state: AttemptState = {
    capturesInputs: providerHooks.capturesInputs ?? providerHooks.capturesContent,
    capturesOutputs: providerHooks.capturesOutputs ?? providerHooks.capturesContent,
    modelKeys: new Map(),
    runtimeContext:
      runtimeContext !== undefined && Object.keys(runtimeContext).length > 0
        ? Object.freeze({ ...runtimeContext })
        : undefined,
    scope,
    toolKeys: new Map(),
  };

  return {
    onStart(event) {
      state.operation = Object.freeze({
        modelId: event.modelId,
        operationId: event.operationId,
        provider: event.provider,
      });
    },
    async onStepStart(event) {
      state.stepNumber = event.stepNumber;
      const started = toStepAttemptStarted(state);
      if (started !== undefined) await providerHooks.publish(started);
    },
    async onLanguageModelCallStart(event) {
      const key = modelCallIdempotencyKey(state.scope, state.stepNumber ?? 0);
      state.modelKeys.set(event.callId, key);
      const started = toModelCallStarted(state, key, event);
      await providerHooks.publish(started);
    },
    executeLanguageModelCall({ callId, execute }) {
      const key = state.modelKeys.get(callId);
      return key === undefined
        ? execute()
        : runInContext({ idempotencyKey: key, scope, type: "model.call" }, execute);
    },
    async onLanguageModelCallEnd(event) {
      const key = state.modelKeys.get(event.callId);
      if (key === undefined) return;
      state.modelKeys.delete(event.callId);
      const completed = toModelCallCompleted(state, key, event);
      await providerHooks.publish(completed);
    },
    async onStepEnd(event) {
      // Step results carry provider metadata (e.g. Vercel AI Gateway cost)
      // that the per-call telemetry events don't. Publish it for providers
      // that know what to do with it; skip when there is none.
      if (event.providerMetadata === undefined) return;
      const providerMetadata = state.capturesOutputs
        ? event.providerMetadata
        : structuralProviderMetadata(event.providerMetadata);
      await providerHooks.publish(
        Object.freeze({
          idempotencyKey: attemptIdempotencyKey(state.scope),
          providerMetadata,
          scope: state.scope,
          type: "step.attempt.metadata",
        }),
      );
    },
    async onToolExecutionStart(event) {
      const key = toolCallIdempotencyKey(
        state.scope,
        event.toolCall.toolCallId,
        state.stepNumber ?? 0,
      );
      state.toolKeys.set(event.toolCall.toolCallId, key);
      const started = toToolCallStarted(state, key, event);
      await providerHooks.publish(started);
    },
    executeTool({ toolCallId, execute }) {
      const key = state.toolKeys.get(toolCallId);
      return key === undefined
        ? execute()
        : runInContext({ idempotencyKey: key, scope, type: "tool.call" }, execute);
    },
    async onToolExecutionEnd(event) {
      const toolCallId = event.toolCall.toolCallId;
      const key = state.toolKeys.get(toolCallId);
      if (key === undefined) return;
      state.toolKeys.delete(toolCallId);
      const completed = toToolCallCompleted(state, key, event);
      await providerHooks.publish(completed);
    },
    async onAbort(event) {
      await failOpenOperations(event.reason);
    },
    async onError(event) {
      await failOpenOperations((event as { readonly error: unknown }).error);
    },
  };

  async function failOpenOperations(error: unknown): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const idempotencyKey of state.modelKeys.values()) {
      pending.push(
        providerHooks.publish(
          Object.freeze({ error, idempotencyKey, scope, type: "model.call.failed" }),
        ),
      );
    }
    for (const idempotencyKey of state.toolKeys.values()) {
      pending.push(
        providerHooks.publish(
          Object.freeze({ error, idempotencyKey, scope, type: "tool.call.failed" }),
        ),
      );
    }
    state.modelKeys.clear();
    state.toolKeys.clear();
    await Promise.all(pending);
  }
}

const directRunInContext: InstrumentationContextRunner = (_operation, execute) => execute();

function toStepAttemptStarted(
  state: AttemptState,
): InstrumentationStepAttemptStartedEvent | undefined {
  if (state.operation === undefined || state.stepNumber === undefined) return undefined;
  return Object.freeze({
    idempotencyKey: attemptIdempotencyKey(state.scope),
    operation: state.operation,
    runtimeContext: state.runtimeContext,
    scope: state.scope,
    type: "step.attempt.started",
  });
}

function toModelCallStarted(
  state: AttemptState,
  idempotencyKey: string,
  source: TelemetryEvent<"onLanguageModelCallStart">,
): InstrumentationModelCallStartedEvent {
  return Object.freeze({
    idempotencyKey,
    input: state.capturesInputs
      ? Object.freeze({
          instructions: source.instructions,
          messages: Object.freeze([...source.messages]),
        })
      : undefined,
    model: Object.freeze({ modelId: source.modelId, provider: source.provider }),
    runtimeContext: state.runtimeContext,
    scope: state.scope,
    type: "model.call.started",
  });
}

function toModelCallCompleted(
  state: AttemptState,
  idempotencyKey: string,
  source: TelemetryEvent<"onLanguageModelCallEnd">,
): InstrumentationModelCallCompletedEvent {
  return Object.freeze({
    content: state.capturesOutputs ? toContentParts(source.content) : undefined,
    finishReason: source.finishReason,
    idempotencyKey,
    scope: state.scope,
    type: "model.call.completed",
    usage: toUsage(source.usage),
  });
}

function toUsage(usage: TelemetryEvent<"onLanguageModelCallEnd">["usage"]): InstrumentationUsage {
  return Object.freeze({
    inputTokenDetails: Object.freeze({
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    }),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });
}

/** Drops kinds eve does not record; see {@link InstrumentationContentPart}. */
function toContentParts(
  content: TelemetryEvent<"onLanguageModelCallEnd">["content"],
): readonly InstrumentationContentPart[] {
  const parts: InstrumentationContentPart[] = [];
  for (const part of content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        parts.push(Object.freeze({ text: part.text, type: part.type }));
        break;
      case "tool-call":
        parts.push(
          Object.freeze({
            callId: part.toolCallId,
            input: part.input,
            toolName: part.toolName,
            type: "tool-call",
          }),
        );
        break;
      case "tool-result":
        parts.push(
          Object.freeze({
            callId: part.toolCallId,
            input: part.input,
            output: part.output,
            toolName: part.toolName,
            type: "tool-result",
          }),
        );
        break;
      case "tool-error":
        parts.push(
          Object.freeze({
            callId: part.toolCallId,
            error: part.error,
            input: part.input,
            toolName: part.toolName,
            type: "tool-error",
          }),
        );
        break;
      default:
        break;
    }
  }
  return Object.freeze(parts);
}

function toToolCallStarted(
  state: AttemptState,
  idempotencyKey: string,
  source: TelemetryEvent<"onToolExecutionStart">,
): InstrumentationToolCallStartedEvent {
  return Object.freeze({
    callId: source.toolCall.toolCallId,
    idempotencyKey,
    input: state.capturesInputs ? source.toolCall.input : undefined,
    scope: state.scope,
    toolName: source.toolCall.toolName,
    type: "tool.call.started",
  });
}

function toToolCallCompleted(
  state: AttemptState,
  idempotencyKey: string,
  source: TelemetryEvent<"onToolExecutionEnd">,
): InstrumentationToolCallCompletedEvent {
  return Object.freeze({
    idempotencyKey,
    output: toToolOutput(source.toolOutput, state.capturesOutputs),
    scope: state.scope,
    type: "tool.call.completed",
  });
}

function toToolOutput(
  toolOutput: TelemetryEvent<"onToolExecutionEnd">["toolOutput"],
  capturesContent: boolean,
): InstrumentationToolOutput {
  if (toolOutput.type === "tool-result") {
    return Object.freeze(
      capturesContent ? { output: toolOutput.output, type: "result" } : { type: "result" },
    );
  }
  return Object.freeze(
    capturesContent ? { error: toolOutput.error, type: "error" } : { type: "error" },
  );
}
