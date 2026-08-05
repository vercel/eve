import type { Telemetry } from "ai";

import type {
  InstrumentationActionKind,
  InstrumentationAttemptScope,
  InstrumentationAttemptStartedEvent,
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
} from "#harness/instrumentation-lifecycle.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

/**
 * Reports what eve dispatches one tool name as. The AI SDK only knows the
 * name, so the kind has to come back from the harness.
 */
export type ActionKindResolver = (toolName: string) => InstrumentationActionKind;

interface AttemptState {
  readonly modelIds: Map<string, string>;
  readonly resolveActionKind: ActionKindResolver;
  readonly scope: InstrumentationAttemptScope;
  readonly toolIds: Map<string, string>;
  operation?: InstrumentationOperationRef;
  // Only the number is kept: it disambiguates call identities within an attempt.
  stepNumber?: number;
}

/** Creates one provider-neutral AI SDK bridge for one actual model attempt. */
export function createAiSdkHookBridge(
  scope: InstrumentationAttemptScope,
  hooks: InstrumentationHooks,
  runInContext: InstrumentationContextRunner = directRunInContext,
  resolveActionKind: ActionKindResolver = defaultResolveActionKind,
): Telemetry {
  const state: AttemptState = {
    modelIds: new Map(),
    resolveActionKind,
    scope,
    toolIds: new Map(),
  };

  return {
    onStart(event) {
      state.operation = {
        modelId: event.modelId,
        operationId: event.operationId,
        provider: event.provider,
      };
    },
    async onStepStart(event) {
      state.stepNumber = event.stepNumber;
      const started = toAttemptStarted(state);
      if (started !== undefined) await hooks.publish(started);
    },
    async onLanguageModelCallStart(event) {
      const id = createModelCallIdentity(state, event.callId);
      state.modelIds.set(event.callId, id);
      const started = toModelCallStarted(state, id, event);
      await hooks.publish(started);
    },
    executeLanguageModelCall({ callId, execute }) {
      const id = state.modelIds.get(callId);
      return id === undefined
        ? execute()
        : runInContext({ id, scope, type: "model.call" }, execute);
    },
    async onLanguageModelCallEnd(event) {
      const id = state.modelIds.get(event.callId);
      if (id === undefined) return;
      state.modelIds.delete(event.callId);
      const completed = toModelCallCompleted(state, id, event);
      await hooks.publish(completed);
    },
    async onStepEnd(event) {
      // Step results carry provider metadata (e.g. Vercel AI Gateway cost)
      // that the per-call telemetry events don't. Publish it for providers
      // that know what to do with it; skip when there is none.
      if (event.providerMetadata === undefined) return;
      await hooks.publish({
        providerMetadata: event.providerMetadata,
        scope: state.scope,
        type: "attempt.metadata",
      });
    },
    async onToolExecutionStart(event) {
      const id = createToolCallIdentity(state, event.toolCall.toolCallId);
      state.toolIds.set(event.toolCall.toolCallId, id);
      const started = toToolCallStarted(state, id, event);
      await hooks.publish(started);
    },
    executeTool({ toolCallId, execute }) {
      const id = state.toolIds.get(toolCallId);
      return id === undefined ? execute() : runInContext({ id, scope, type: "tool.call" }, execute);
    },
    async onToolExecutionEnd(event) {
      const toolCallId = event.toolCall.toolCallId;
      const id = state.toolIds.get(toolCallId);
      if (id === undefined) return;
      state.toolIds.delete(toolCallId);
      const completed = toToolCallCompleted(state, id, event);
      await hooks.publish(completed);
    },
    async onAbort(event) {
      await failOpenOperations(event);
    },
    async onError(error) {
      await failOpenOperations(error);
    },
  };

  async function failOpenOperations(error: unknown): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const id of state.modelIds.values()) {
      pending.push(hooks.publish({ error, id, scope, type: "model.call.failed" }));
    }
    for (const id of state.toolIds.values()) {
      pending.push(hooks.publish({ error, id, scope, type: "tool.call.failed" }));
    }
    state.modelIds.clear();
    state.toolIds.clear();
    await Promise.all(pending);
  }
}

const directRunInContext: InstrumentationContextRunner = (_operation, execute) => execute();

const defaultResolveActionKind: ActionKindResolver = () => "tool-call";

function toAttemptStarted(state: AttemptState): InstrumentationAttemptStartedEvent | undefined {
  if (state.operation === undefined || state.stepNumber === undefined) return undefined;
  return {
    operation: state.operation,
    scope: state.scope,
    type: "attempt.started",
  };
}

function createModelCallIdentity(state: AttemptState, callId: string): string {
  return `${state.scope.attemptId}:model:${callId}:${state.stepNumber ?? 0}`;
}

function toModelCallStarted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onLanguageModelCallStart">,
): InstrumentationModelCallStartedEvent {
  return {
    id,
    input: { instructions: source.instructions, messages: source.messages },
    model: { modelId: source.modelId, provider: source.provider },
    scope: state.scope,
    type: "model.call.started",
  };
}

function toModelCallCompleted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onLanguageModelCallEnd">,
): InstrumentationModelCallCompletedEvent {
  return {
    content: toContentParts(source.content),
    finishReason: source.finishReason,
    id,
    scope: state.scope,
    type: "model.call.completed",
    usage: toUsage(source.usage),
  };
}

function toUsage(usage: TelemetryEvent<"onLanguageModelCallEnd">["usage"]): InstrumentationUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
    },
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
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
        parts.push({ text: part.text, type: part.type });
        break;
      case "tool-call":
        parts.push({ input: part.input, toolName: part.toolName, type: "tool-call" });
        break;
      case "tool-result":
        parts.push({
          input: part.input,
          output: part.output,
          toolName: part.toolName,
          type: "tool-result",
        });
        break;
      case "tool-error":
        parts.push({
          error: part.error,
          input: part.input,
          toolName: part.toolName,
          type: "tool-error",
        });
        break;
      default:
        break;
    }
  }
  return parts;
}

function createToolCallIdentity(state: AttemptState, toolCallId: string): string {
  return `${state.scope.attemptId}:tool:${toolCallId}:${state.stepNumber ?? 0}`;
}

function toToolCallStarted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onToolExecutionStart">,
): InstrumentationToolCallStartedEvent {
  return {
    callId: source.toolCall.toolCallId,
    id,
    input: source.toolCall.input,
    kind: state.resolveActionKind(source.toolCall.toolName),
    scope: state.scope,
    toolName: source.toolCall.toolName,
    type: "tool.call.started",
  };
}

function toToolCallCompleted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onToolExecutionEnd">,
): InstrumentationToolCallCompletedEvent {
  return {
    id,
    output: toToolOutput(source.toolOutput),
    scope: state.scope,
    type: "tool.call.completed",
  };
}

function toToolOutput(
  toolOutput: TelemetryEvent<"onToolExecutionEnd">["toolOutput"],
): InstrumentationToolOutput {
  return toolOutput.type === "tool-result"
    ? { output: toolOutput.output, type: "result" }
    : { error: toolOutput.error, type: "error" };
}
