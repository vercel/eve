import { describe, expect, it, vi } from "vitest";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  attemptIdempotencyKey,
  createInstrumentationHooks,
  modelCallIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationModelCallStartedEvent,
  type InstrumentationModelCallTerminalEvent,
  type InstrumentationProviderDefinition,
  type InstrumentationStepAttemptMetadataEvent,
  type InstrumentationStepAttemptStartedEvent,
  type InstrumentationToolCallStartedEvent,
  type InstrumentationToolCallTerminalEvent,
} from "#harness/instrumentation/lifecycle.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "turn-1:step-0:attempt-0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("createAiSdkHookBridge", () => {
  it("publishes normalized model lifecycle to every provider", async () => {
    const calls: string[] = [];
    const provider = (name: string): InstrumentationProviderDefinition => {
      const states = new Map<string, string>();
      return {
        events: {
          "model.call.started"(event) {
            calls.push(`${name}:started:${event.idempotencyKey}`);
            states.set(event.idempotencyKey, `${name}-state`);
          },
          "model.call.completed"(event) {
            calls.push(
              `${name}:completed:${event.idempotencyKey}:${String(states.get(event.idempotencyKey))}`,
            );
          },
        },
        name,
      };
    };
    const hooks = createInstrumentationHooks([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const id = modelCallIdempotencyKey(scope, 0);
    expect(calls).toEqual([
      `a:started:${id}`,
      `b:started:${id}`,
      `a:completed:${id}:a-state`,
      `b:completed:${id}:b-state`,
    ]);
  });

  it("uses an eve-owned context runner while executing the model exactly once", async () => {
    const order: string[] = [];
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks, async (_operation, execute) => {
      order.push("enter");
      const result = await execute();
      order.push("exit");
      return result;
    });
    const execute = vi.fn(async () => "result");
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);

    const result = await bridge.executeLanguageModelCall!({
      callId: "call-1",
      execute,
    });

    expect(result).toBe("result");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["enter", "exit"]);
  });

  it("passes the identity captured at model-call start to the context runner", async () => {
    const ids: string[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: { "model.call.started": (event) => void ids.push(event.idempotencyKey) },
        name: "recorder",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks, (operation, execute) => {
      ids.push(operation.idempotencyKey);
      return execute();
    });
    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 1 }]);

    await bridge.executeLanguageModelCall!({ callId: "call-1", execute: async () => "result" });

    const expected = modelCallIdempotencyKey(scope, 0);
    expect(ids).toEqual([expected, expected]);
  });

  it("executes directly when no start identity exists", async () => {
    let adapterCalls = 0;
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks, (_operation, execute) => {
      adapterCalls += 1;
      return execute();
    });
    const execute = vi.fn(async () => "result");

    expect(await bridge.executeLanguageModelCall!({ callId: "missing", execute })).toBe("result");
    expect(execute).toHaveBeenCalledOnce();
    expect(adapterCalls).toBe(0);
  });

  it("derives replay-stable model identity without the AI SDK call ID", async () => {
    const keys: string[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: { "model.call.started": (event) => void keys.push(event.idempotencyKey) },
        name: "keys",
      },
    ]);

    for (const callId of ["sdk-random-1", "sdk-random-2"]) {
      const bridge = createAiSdkHookBridge(scope, hooks);
      await Reflect.apply(bridge.onStepStart!, bridge, [{ callId, stepNumber: 2 }]);
      await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
        { callId, messages: [], modelId: "model", provider: "test", tools: undefined },
      ]);
    }

    expect(keys).toEqual([modelCallIdempotencyKey(scope, 2), modelCallIdempotencyKey(scope, 2)]);
  });

  it("publishes step provider metadata as step.metadata, skipping steps without any", async () => {
    const events: InstrumentationStepAttemptMetadataEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "step.attempt.metadata": (event) => {
            events.push(event);
          },
        },
        name: "metadata",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onStepEnd!, bridge, [
      {
        providerMetadata: {
          gateway: {
            cost: "0.000082",
            generationId: "generation-1",
            groundingSegments: ["private result"],
          },
          google: { searchQueries: ["private query"] },
        },
      },
    ]);
    await Reflect.apply(bridge.onStepEnd!, bridge, [{ providerMetadata: undefined }]);

    expect(events).toEqual([
      {
        idempotencyKey: attemptIdempotencyKey(scope),
        providerMetadata: { gateway: { cost: "0.000082", generationId: "generation-1" } },
        scope,
        type: "step.attempt.metadata",
      },
    ]);
  });

  it("isolates a failing provider from the remaining providers", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "model.call.started"() {
            throw new Error("provider failed");
          },
        },
        name: "thrower",
      },
      {
        events: {
          "model.call.completed": after,
        },
        name: "after",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    expect(after).toHaveBeenCalledOnce();
  });

  it("terminalizes started operations when the attempt errors", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      { capture: "content", events: { "model.call.failed": after }, name: "after" },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    const error = new Error("model failed");
    await Reflect.apply(bridge.onError!, bridge, [{ callId: "call-1", error }]);

    expect(after).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error, type: "model.call.failed" }),
      expect.anything(),
    );
  });

  it("terminalizes started operations with the abort reason", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      { capture: "content", events: { "tool.call.failed": after }, name: "after" },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const toolCall = { input: {}, toolCallId: "tool-1", toolName: "search" };

    await Reflect.apply(bridge.onToolExecutionStart!, bridge, [{ callId: "call-1", toolCall }]);
    const reason = new Error("model aborted");
    await Reflect.apply(bridge.onAbort!, bridge, [{ callId: "call-1", reason, steps: [] }]);

    expect(after).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error: reason, type: "tool.call.failed" }),
      expect.anything(),
    );
  });

  it("publishes an immutable operation projection to every provider", async () => {
    const mutator = vi.fn((event: InstrumentationStepAttemptStartedEvent) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.operation)).toBe(true);
      expect(Reflect.set(event.operation, "modelId", "corrupted-model")).toBe(false);
      expect(Reflect.set(event.operation, "operationId", "corrupted-operation")).toBe(false);
      expect(Reflect.set(event.operation, "provider", "corrupted-provider")).toBe(false);
    });
    const started = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "step.attempt.started": mutator }, name: "mutator" },
      { events: { "step.attempt.started": started }, name: "started" },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);

    const expected = {
      idempotencyKey: attemptIdempotencyKey(scope),
      operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "step.attempt.started",
    };
    expect(mutator).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
    expect(started).toHaveBeenCalledExactlyOnceWith(expected, expect.anything());
  });

  it("projects the model call callbacks onto eve fields only", async () => {
    const before = vi.fn((event: InstrumentationModelCallStartedEvent) => {
      if (event.input === undefined) throw new Error("expected model input");
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.input)).toBe(true);
      expect(Object.isFrozen(event.input.messages)).toBe(true);
      expect(Object.isFrozen(event.model)).toBe(true);
    });
    const after = vi.fn((event: InstrumentationModelCallTerminalEvent) => {
      if (event.type !== "model.call.completed") throw new Error("expected completed model call");
      if (event.content === undefined) throw new Error("expected model content");
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.content)).toBe(true);
      expect(event.content.every((part) => Object.isFrozen(part))).toBe(true);
      expect(Object.isFrozen(event.usage)).toBe(true);
      expect(Object.isFrozen(event.usage.inputTokenDetails)).toBe(true);
    });
    const hooks = createInstrumentationHooks([
      {
        capture: "content",
        events: { "model.call.completed": after, "model.call.started": before },
        name: "spy",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      {
        callId: "call-1",
        instructions: "be brief",
        messages: [{ content: "hi", role: "user" }],
        modelId: "model",
        provider: "test",
        tools: undefined,
      },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [
          { text: "thinking", type: "reasoning" },
          { text: "hello", type: "text" },
          { input: { a: 1 }, toolCallId: "tool-1", toolName: "search", type: "tool-call" },
          {
            input: { a: 1 },
            output: "ok",
            toolCallId: "tool-1",
            toolName: "search",
            type: "tool-result",
          },
          {
            error: "boom",
            input: { a: 2 },
            toolCallId: "tool-2",
            toolName: "search",
            type: "tool-error",
          },
          { type: "some-future-kind" },
        ],
        finishReason: "tool-calls",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
          inputTokens: 1,
          outputTokens: 2,
        },
      },
    ]);

    expect(before).toHaveBeenCalledExactlyOnceWith(
      {
        idempotencyKey: modelCallIdempotencyKey(scope, 0),
        input: { instructions: "be brief", messages: [{ content: "hi", role: "user" }] },
        model: { modelId: "model", provider: "test" },
        scope,
        type: "model.call.started",
      },
      expect.anything(),
    );
    // An unrecognized part kind is dropped rather than forwarded, so widening
    // InstrumentationContentPart is what makes a new kind reachable.
    expect(after).toHaveBeenCalledExactlyOnceWith(
      {
        content: [
          { text: "thinking", type: "reasoning" },
          { text: "hello", type: "text" },
          { callId: "tool-1", input: { a: 1 }, toolName: "search", type: "tool-call" },
          {
            callId: "tool-1",
            input: { a: 1 },
            output: "ok",
            toolName: "search",
            type: "tool-result",
          },
          {
            callId: "tool-2",
            error: "boom",
            input: { a: 2 },
            toolName: "search",
            type: "tool-error",
          },
        ],
        finishReason: "tool-calls",
        idempotencyKey: modelCallIdempotencyKey(scope, 0),
        scope,
        type: "model.call.completed",
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
          inputTokens: 1,
          outputTokens: 2,
        },
      },
      expect.anything(),
    );
  });

  it.each([
    {
      expected: { output: "ok", type: "result" },
      toolOutput: { output: "ok", type: "tool-result" },
    },
    {
      expected: { error: "boom", type: "error" },
      toolOutput: { error: "boom", type: "tool-error" },
    },
  ])(
    "collapses tool output $toolOutput.type onto $expected.type",
    async ({ expected, toolOutput }) => {
      const before = vi.fn((event: InstrumentationToolCallStartedEvent) => {
        expect(Object.isFrozen(event)).toBe(true);
      });
      const after = vi.fn((event: InstrumentationToolCallTerminalEvent) => {
        if (event.type !== "tool.call.completed") throw new Error("expected completed tool call");
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.output)).toBe(true);
      });
      const actionStarted = vi.fn();
      const hooks = createInstrumentationHooks([
        {
          capture: "content",
          events: {
            "action.started": actionStarted,
            "tool.call.completed": after,
            "tool.call.started": before,
          },
          name: "spy",
        },
      ]);
      const bridge = createAiSdkHookBridge(scope, hooks);
      const toolCall = { input: { q: "eve" }, toolCallId: "tool-1", toolName: "search" };

      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [{ callId: "call-1", toolCall }]);
      await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        { callId: "call-1", toolCall, toolExecutionMs: 1, toolOutput },
      ]);

      expect(before).toHaveBeenCalledExactlyOnceWith(
        {
          callId: "tool-1",
          idempotencyKey: `tool:${scope.attemptId}:tool-1:0`,
          input: { q: "eve" },
          scope,
          toolName: "search",
          type: "tool.call.started",
        },
        expect.anything(),
      );
      expect(after).toHaveBeenCalledExactlyOnceWith(
        {
          idempotencyKey: `tool:${scope.attemptId}:tool-1:0`,
          output: expected,
          scope,
          type: "tool.call.completed",
        },
        expect.anything(),
      );
      expect(actionStarted).not.toHaveBeenCalled();
    },
  );

  it("omits content from the projection when no provider asked for it", async () => {
    const modelStarted = vi.fn();
    const modelCompleted = vi.fn();
    const toolStarted = vi.fn();
    const toolCompleted = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "model.call.completed": modelCompleted,
          "model.call.started": modelStarted,
          "tool.call.completed": toolCompleted,
          "tool.call.started": toolStarted,
        },
        name: "metadata-only",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const toolCall = { input: { q: "eve" }, toolCallId: "tool-1", toolName: "search" };

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      {
        callId: "call-1",
        instructions: "be brief",
        messages: [{ content: "hi", role: "user" }],
        modelId: "model",
        provider: "test",
        tools: undefined,
      },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [{ text: "hello", type: "text" }],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ]);
    await Reflect.apply(bridge.onToolExecutionStart!, bridge, [{ callId: "call-1", toolCall }]);
    await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
      {
        callId: "call-1",
        toolCall,
        toolExecutionMs: 1,
        toolOutput: { output: "ok", type: "tool-result" },
      },
    ]);

    expect(modelStarted.mock.calls[0]?.[0].input).toBeUndefined();
    expect(modelCompleted.mock.calls[0]?.[0].content).toBeUndefined();
    // Structure survives: usage, the finish reason, and the tool's identity are
    // not what was said.
    expect(modelCompleted.mock.calls[0]?.[0].finishReason).toBe("stop");
    expect(toolStarted.mock.calls[0]?.[0].input).toBeUndefined();
    expect(toolStarted.mock.calls[0]?.[0].toolName).toBe("search");
    expect(toolCompleted.mock.calls[0]?.[0].output).toEqual({ type: "result" });
  });

  it("withholds content from a metadata provider sharing a bus with a content one", async () => {
    const metadataOnly = vi.fn();
    const wantsContent = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "tool.call.started": metadataOnly }, name: "metadata-only" },
      {
        capture: "content",
        events: { "tool.call.started": wantsContent },
        name: "wants-content",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
      { callId: "call-1", toolCall: { input: { q: "eve" }, toolCallId: "t", toolName: "search" } },
    ]);

    expect(wantsContent.mock.calls[0]?.[0].input).toEqual({ q: "eve" });
    expect(metadataOnly.mock.calls[0]?.[0].input).toBeUndefined();
    expect(metadataOnly.mock.calls[0]?.[0].toolName).toBe("search");
  });
  it("keeps each provider's state to itself", async () => {
    const observed = new Map<string, unknown>();
    const provider = (name: string): InstrumentationProviderDefinition => {
      const own = new Map<string, string>();
      return {
        events: {
          "model.call.completed": (event) => {
            observed.set(name, own.get(event.idempotencyKey));
          },
          "model.call.started": (event) => void own.set(event.idempotencyKey, `${name}-state`),
        },
        name,
      };
    };
    const hooks = createInstrumentationHooks([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    expect(observed).toEqual(
      new Map([
        ["a", "a-state"],
        ["b", "b-state"],
      ]),
    );
  });

  it("skips a terminal handler when the operation never started", async () => {
    const completed = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "model.call.completed": completed }, name: "completed" },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    // No onLanguageModelCallStart, so the bridge holds no id and publishes
    // nothing — the handler must not run against empty state.
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    expect(completed).not.toHaveBeenCalled();
  });

  it("retains state for parallel tool starts", async () => {
    const resolvers = new Map<string, () => void>();
    const started = new Map<string, string>();
    const terminalStates = new Map<string, unknown>();
    const hooks = createInstrumentationHooks([
      {
        events: {
          async "tool.call.started"(event) {
            started.set(
              event.idempotencyKey,
              await new Promise<string>((resolve) => {
                resolvers.set(event.idempotencyKey, () => resolve(`state:${event.idempotencyKey}`));
              }),
            );
          },
          "tool.call.completed"(event) {
            terminalStates.set(event.idempotencyKey, started.get(event.idempotencyKey));
          },
        },
        name: "parallel",
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const start = (toolCallId: string) =>
      Reflect.apply(bridge.onToolExecutionStart!, bridge, [
        {
          callId: "call-1",
          toolCall: { input: {}, toolCallId, toolName: "search" },
        },
      ]);
    const first = start("tool-1");
    const second = start("tool-2");
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    const firstId = `tool:${scope.attemptId}:tool-1:0`;
    const secondId = `tool:${scope.attemptId}:tool-2:0`;
    resolvers.get(secondId)!();
    resolvers.get(firstId)!();
    await Promise.all([first, second]);

    const end = (toolCallId: string) =>
      Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        {
          callId: "call-1",
          messages: [],
          toolCall: { input: {}, toolCallId, toolName: "search" },
          toolExecutionMs: 1,
          toolOutput: { output: {}, type: "tool-result" },
        },
      ]);
    await Promise.all([end("tool-1"), end("tool-2")]);

    expect(terminalStates).toEqual(
      new Map([
        [firstId, `state:${firstId}`],
        [secondId, `state:${secondId}`],
      ]),
    );
  });
});
