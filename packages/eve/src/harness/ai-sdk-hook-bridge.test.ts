import { describe, expect, it, vi } from "vitest";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  createInstrumentationHooks,
  type InstrumentationStepMetadataEvent,
  type InstrumentationAttemptScope,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";

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
            calls.push(`${name}:started:${event.id}`);
            states.set(event.id, `${name}-state`);
          },
          "model.call.completed"(event) {
            calls.push(`${name}:completed:${event.id}:${String(states.get(event.id))}`);
          },
        },
      };
    };
    const hooks = createInstrumentationHooks([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
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

    const id = `${scope.attemptId}:model:call-1:0`;
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
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
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
      { events: { "model.call.started": (event) => void ids.push(event.id) } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks, (operation, execute) => {
      ids.push(operation.id);
      return execute();
    });
    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 1 }]);

    await bridge.executeLanguageModelCall!({ callId: "call-1", execute: async () => "result" });

    const expected = `${scope.attemptId}:model:call-1:0`;
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

  it("publishes step provider metadata as step.metadata, skipping steps without any", async () => {
    const events: InstrumentationStepMetadataEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "step.metadata": (event) => {
            events.push(event);
          },
        },
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onStepEnd!, bridge, [
      { providerMetadata: { gateway: { cost: "0.000082" } } },
    ]);
    await Reflect.apply(bridge.onStepEnd!, bridge, [{ providerMetadata: undefined }]);

    expect(events).toEqual([
      {
        providerMetadata: { gateway: { cost: "0.000082" } },
        scope,
        type: "step.metadata",
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
      },
      {
        events: {
          "model.call.completed": after,
        },
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
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
    const hooks = createInstrumentationHooks([{ events: { "model.call.failed": after } }]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
    ]);
    const error = new Error("model failed");
    await Reflect.apply(bridge.onError!, bridge, [error]);

    expect(after).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error, type: "model.call.failed" }),
    );
  });

  it("projects the operation callback onto eve fields only", async () => {
    const started = vi.fn();
    const hooks = createInstrumentationHooks([{ events: { "step.started": started } }]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);

    expect(started).toHaveBeenCalledExactlyOnceWith({
      operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "step.started",
    });
  });

  it("projects the model call callbacks onto eve fields only", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "model.call.completed": after, "model.call.started": before } },
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
          { input: { a: 1 }, toolName: "search", type: "tool-call" },
          { input: { a: 1 }, output: "ok", toolName: "search", type: "tool-result" },
          { error: "boom", input: { a: 2 }, toolName: "search", type: "tool-error" },
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

    expect(before).toHaveBeenCalledExactlyOnceWith({
      id: `${scope.attemptId}:model:call-1:0`,
      input: { instructions: "be brief", messages: [{ content: "hi", role: "user" }] },
      model: { modelId: "model", provider: "test" },
      scope,
      type: "model.call.started",
    });
    // An unrecognized part kind is dropped rather than forwarded, so widening
    // InstrumentationContentPart is what makes a new kind reachable.
    expect(after).toHaveBeenCalledExactlyOnceWith({
      content: [
        { text: "thinking", type: "reasoning" },
        { text: "hello", type: "text" },
        { input: { a: 1 }, toolName: "search", type: "tool-call" },
        { input: { a: 1 }, output: "ok", toolName: "search", type: "tool-result" },
        { error: "boom", input: { a: 2 }, toolName: "search", type: "tool-error" },
      ],
      finishReason: "tool-calls",
      id: `${scope.attemptId}:model:call-1:0`,
      scope,
      type: "model.call.completed",
      usage: {
        inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
        inputTokens: 1,
        outputTokens: 2,
      },
    });
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
      const before = vi.fn();
      const after = vi.fn();
      const hooks = createInstrumentationHooks([
        { events: { "tool.call.completed": after, "tool.call.started": before } },
      ]);
      const bridge = createAiSdkHookBridge(scope, hooks);
      const toolCall = { input: { q: "eve" }, toolCallId: "tool-1", toolName: "search" };

      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [{ callId: "call-1", toolCall }]);
      await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        { callId: "call-1", toolCall, toolExecutionMs: 1, toolOutput },
      ]);

      expect(before).toHaveBeenCalledExactlyOnceWith({
        callId: "tool-1",
        id: `${scope.attemptId}:tool:tool-1:0`,
        input: { q: "eve" },
        kind: "tool-call",
        scope,
        toolName: "search",
        type: "tool.call.started",
      });
      expect(after).toHaveBeenCalledExactlyOnceWith({
        id: `${scope.attemptId}:tool:tool-1:0`,
        output: expected,
        scope,
        type: "tool.call.completed",
      });
    },
  );

  it("labels a tool call with the kind the harness resolves", async () => {
    const started = vi.fn();
    const hooks = createInstrumentationHooks([{ events: { "tool.call.started": started } }]);
    const bridge = createAiSdkHookBridge(scope, hooks, undefined, (toolName) =>
      toolName === "research" ? "subagent-call" : "tool-call",
    );

    for (const toolName of ["research", "search"]) {
      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [
        { callId: `call-${toolName}`, toolCall: { input: {}, toolCallId: toolName, toolName } },
      ]);
    }

    expect(started.mock.calls.map(([event]) => [event.toolName, event.kind])).toEqual([
      ["research", "subagent-call"],
      ["search", "tool-call"],
    ]);
  });

  it("keeps each provider's state to itself", async () => {
    const observed = new Map<string, unknown>();
    const provider = (name: string): InstrumentationProviderDefinition => {
      const own = new Map<string, string>();
      return {
        events: {
          "model.call.completed": (event) => {
            observed.set(name, own.get(event.id));
          },
          "model.call.started": (event) => void own.set(event.id, `${name}-state`),
        },
      };
    };
    const hooks = createInstrumentationHooks([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
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
    const hooks = createInstrumentationHooks([{ events: { "model.call.completed": completed } }]);
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
              event.id,
              await new Promise<string>((resolve) => {
                resolvers.set(event.id, () => resolve(`state:${event.id}`));
              }),
            );
          },
          "tool.call.completed"(event) {
            terminalStates.set(event.id, started.get(event.id));
          },
        },
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

    const firstId = `${scope.attemptId}:tool:tool-1:0`;
    const secondId = `${scope.attemptId}:tool:tool-2:0`;
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
