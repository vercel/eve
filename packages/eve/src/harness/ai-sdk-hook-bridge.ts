import type { Telemetry } from "ai";

import type {
  InstrumentationAttemptScope,
  InstrumentationAttemptStartedEvent,
  InstrumentationContextRunner,
  InstrumentationHooks,
  InstrumentationModelCallCompletedEvent,
  InstrumentationModelCallStartedEvent,
  InstrumentationToolCallCompletedEvent,
  InstrumentationToolCallStartedEvent,
} from "#harness/instrumentation-lifecycle.js";

type TelemetryEvent<TKey extends keyof Telemetry> = Parameters<NonNullable<Telemetry[TKey]>>[0];

interface AttemptState {
  readonly modelIds: Map<string, string>;
  readonly scope: InstrumentationAttemptScope;
  readonly toolIds: Map<string, string>;
  operationStart?: Readonly<TelemetryEvent<"onStart">>;
  stepStart?: Readonly<TelemetryEvent<"onStepStart">>;
}

/** Creates one provider-neutral AI SDK bridge for one actual model attempt. */
export function createAiSdkHookBridge(
  scope: InstrumentationAttemptScope,
  hooks: InstrumentationHooks,
  runInContext: InstrumentationContextRunner = directRunInContext,
): Telemetry {
  const state: AttemptState = {
    modelIds: new Map(),
    scope,
    toolIds: new Map(),
  };

  return {
    onStart(event) {
      state.operationStart = snapshot(event);
    },
    async onStepStart(event) {
      state.stepStart = snapshot(event);
      const started = toAttemptStarted(state);
      if (started !== undefined) await hooks.publish(started);
    },
    async onLanguageModelCallStart(event) {
      const id = createModelCallIdentity(state, event.callId);
      state.modelIds.set(event.callId, id);
      const started = toModelCallStarted(state, id, event);
      await hooks.before("model.call", started);
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
      await hooks.after("model.call", completed);
    },
    async onToolExecutionStart(event) {
      const id = createToolCallIdentity(state, event.toolCall.toolCallId);
      state.toolIds.set(event.toolCall.toolCallId, id);
      const started = toToolCallStarted(state, id, event);
      await hooks.before("tool.call", started);
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
      await hooks.after("tool.call", completed);
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
      pending.push(hooks.after("model.call", { error, id, scope, type: "model.call.failed" }));
    }
    for (const id of state.toolIds.values()) {
      pending.push(hooks.after("tool.call", { error, id, scope, type: "tool.call.failed" }));
    }
    state.modelIds.clear();
    state.toolIds.clear();
    await Promise.all(pending);
  }
}

const directRunInContext: InstrumentationContextRunner = (_operation, execute) => execute();

function snapshot<T extends object>(event: T): Readonly<T> {
  return Object.freeze({ ...event });
}

function toAttemptStarted(state: AttemptState): InstrumentationAttemptStartedEvent | undefined {
  if (state.operationStart === undefined || state.stepStart === undefined) return undefined;
  return {
    operation: state.operationStart,
    scope: state.scope,
    step: state.stepStart,
    type: "attempt.started",
  };
}

function createModelCallIdentity(state: AttemptState, callId: string): string {
  return `${state.scope.attemptId}:model:${callId}:${state.stepStart?.stepNumber ?? 0}`;
}

function toModelCallStarted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onLanguageModelCallStart">,
): InstrumentationModelCallStartedEvent {
  return {
    id,
    scope: state.scope,
    source: snapshot(source),
    type: "model.call.started",
  };
}

function toModelCallCompleted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onLanguageModelCallEnd">,
): InstrumentationModelCallCompletedEvent {
  return {
    id,
    scope: state.scope,
    source: snapshot(source),
    type: "model.call.completed",
  };
}

function createToolCallIdentity(state: AttemptState, toolCallId: string): string {
  return `${state.scope.attemptId}:tool:${toolCallId}:${state.stepStart?.stepNumber ?? 0}`;
}

function toToolCallStarted(
  state: AttemptState,
  id: string,
  source: TelemetryEvent<"onToolExecutionStart">,
): InstrumentationToolCallStartedEvent {
  return {
    id,
    scope: state.scope,
    source: snapshot(source),
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
    scope: state.scope,
    source: snapshot(source),
    type: "tool.call.completed",
  };
}
