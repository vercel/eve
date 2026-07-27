import { describe, expect, it, vi } from "vitest";

import { createAiSdkHookBridge, getAttemptState } from "#harness/ai-sdk-hook-bridge.js";
import {
  createInstrumentationHooks,
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
    const provider = (name: string): InstrumentationProviderDefinition => ({
      events: {
        "model.call": {
          before(event) {
            calls.push(`${name}:before:${event.id}`);
            return `${name}-state`;
          },
          after(event, state) {
            calls.push(`${name}:after:${event.id}:${String(state)}`);
          },
        },
      },
    });
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
      `a:before:${id}`,
      `b:before:${id}`,
      `a:after:${id}:a-state`,
      `b:after:${id}:b-state`,
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
      { events: { "model.call": { before: (event) => ids.push(event.id) } } },
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

  it("isolates a failing provider from the remaining providers", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "model.call": {
            before() {
              throw new Error("provider failed");
            },
          },
        },
      },
      { events: { "model.call": { before: () => "state", after } } },
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
    const hooks = createInstrumentationHooks([
      { events: { "model.call": { before: () => "state", after } } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", modelId: "model", provider: "test", tools: undefined },
    ]);
    const error = new Error("model failed");
    await Reflect.apply(bridge.onError!, bridge, [error]);

    expect(after).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error, type: "model.call.failed" }),
      "state",
    );
  });

  it("stores callback snapshots by attempt scope", () => {
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const event = {
      callId: "call-1",
      modelId: "model",
      operationId: "ai.streamText",
      provider: "test",
    };

    Reflect.apply(bridge.onStart!, bridge, [event]);

    expect(getAttemptState(scope)?.operationStart).toEqual(event);
    expect(getAttemptState(scope)?.operationStart).not.toBe(event);
    expect(Object.isFrozen(getAttemptState(scope)?.operationStart)).toBe(true);
  });

  it("snapshots errors consistently", async () => {
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const error = new Error("failed");

    await Reflect.apply(bridge.onError!, bridge, [error]);

    expect(getAttemptState(scope)?.operationError).toEqual(
      expect.objectContaining({ message: "failed", name: "Error" }),
    );
    expect(getAttemptState(scope)?.operationError).not.toBe(error);
    expect(Object.isFrozen(getAttemptState(scope)?.operationError)).toBe(true);
  });

  it("retains state for parallel tool starts", async () => {
    const resolvers = new Map<string, () => void>();
    const terminalStates = new Map<string, unknown>();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "tool.call": {
            before(event) {
              return new Promise<string>((resolve) => {
                resolvers.set(event.id, () => resolve(`state:${event.id}`));
              });
            },
            after(event, state) {
              terminalStates.set(event.id, state);
            },
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
