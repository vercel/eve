import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  emitStreamContent,
  getHarnessEmissionState,
  type HarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { HarnessEmitFn, HarnessSession } from "#harness/types.js";
import { EMPTY_DELIVERY_SENTINEL } from "#shared/empty-delivery.js";

async function* streamOf(parts: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> {
  for (const part of parts) {
    yield part;
  }
}

const EMISSION_STATE: HarnessEmissionState = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

function createEmitStub(): HarnessEmitFn {
  return vi.fn(async () => {});
}

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "test",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:test",
    history: [],
    sessionId: "sess-test",
    state,
  };
}

describe("getHarnessEmissionState", () => {
  it("returns defaults when no state exists", () => {
    expect(getHarnessEmissionState(createSession().state)).toEqual({
      sessionStarted: false,
      sequence: 0,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("returns defaults when state key is missing", () => {
    expect(getHarnessEmissionState(createSession({ other: "value" }).state)).toEqual({
      sessionStarted: false,
      sequence: 0,
      stepIndex: 0,
      turnId: "",
    });
  });

  it("reads persisted emission state", () => {
    const session = createSession({
      "eve.harness.emission": {
        sessionStarted: true,
        sequence: 3,
        stepIndex: 1,
        turnId: "turn_3",
      },
    });

    expect(getHarnessEmissionState(session.state)).toEqual({
      sessionStarted: true,
      sequence: 3,
      stepIndex: 1,
      turnId: "turn_3",
    });
  });
});

describe("setHarnessEmissionState", () => {
  it("writes emission state to the session", () => {
    const session = createSession();
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 2,
      stepIndex: 0,
      turnId: "turn_2",
    };

    const updated = setHarnessEmissionState(session, state);

    expect(getHarnessEmissionState(updated.state)).toEqual(state);
  });

  it("preserves existing session state keys", () => {
    const session = createSession({ "other.key": "preserved" });
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    };

    const updated = setHarnessEmissionState(session, state);

    expect(updated.state?.["other.key"]).toBe("preserved");
    expect(getHarnessEmissionState(updated.state)).toEqual(state);
  });

  it("round-trips through get after set", () => {
    const state: HarnessEmissionState = {
      sessionStarted: true,
      sequence: 5,
      stepIndex: 2,
      turnId: "turn_5",
    };

    const session = setHarnessEmissionState(createSession(), state);
    const retrieved = getHarnessEmissionState(session.state);

    expect(retrieved).toEqual(state);
  });
});

describe("emitStreamContent empty delivery", () => {
  it("reduces 368 saturated deltas to eight bounded dispatches", async () => {
    const deltaCount = 368;
    const writeReleases: Array<() => void> = [];
    let providerDeltas = 0;
    let providerFinished = false;
    const emit = vi.fn(async (_event: Parameters<HarnessEmitFn>[0]) => {
      await new Promise<void>((resolve) => {
        writeReleases.push(resolve);
      });
    });
    async function* controlledStream(): AsyncIterable<TextStreamPart<ToolSet>> {
      for (let index = 0; index < deltaCount; index += 1) {
        providerDeltas += 1;
        yield { id: "text-1", text: "x", type: "text-delta" } as TextStreamPart<ToolSet>;
      }
      yield { finishReason: "stop", type: "finish-step" } as TextStreamPart<ToolSet>;
      providerFinished = true;
    }

    const run = emitStreamContent(emit, EMISSION_STATE, controlledStream());
    await vi.waitFor(() => expect(providerDeltas).toBe(65));
    expect(providerFinished).toBe(false);
    expect(emit).toHaveBeenCalledTimes(1);

    for (let writeIndex = 0; writeIndex < 8; writeIndex += 1) {
      await vi.waitFor(() => expect(writeReleases.length).toBe(writeIndex + 1));
      writeReleases[writeIndex]?.();
    }
    await run;

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    const appended = events.filter((event) => event.type === "message.appended");
    expect(providerFinished).toBe(true);
    expect(events).toHaveLength(8);
    expect(appended.map((event) => event.data.messageDelta.length)).toEqual([
      1, 64, 64, 64, 64, 64, 47,
    ]);
    expect(appended.at(-1)?.data.messageSoFar).toBe("x".repeat(deltaCount));
    expect(events.at(-1)?.type).toBe("message.completed");
  });

  it("streams a split sentinel immediately and completes with a null message", async () => {
    const emit = createEmitStub();

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "text-1", text: "  <eve-empty", type: "text-delta" },
        { id: "text-1", text: "-delivery/>  ", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
    );

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    expect(events.map((event) => event.type)).toEqual([
      "message.appended",
      "message.appended",
      "message.completed",
    ]);
    expect(events[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ messageDelta: "  <eve-empty" }),
      }),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ finishReason: "stop", message: null }),
      }),
    );
  });

  it("preserves normal text that initially resembles the sentinel", async () => {
    const emit = createEmitStub();
    const message = "<eve-empty-delivery is not a marker";

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "text-1", text: "<eve-empty", type: "text-delta" },
        { id: "text-1", text: "-delivery is not a marker", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
    );

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.type === "message.appended")).toHaveLength(2);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message }),
        type: "message.completed",
      }),
    );
  });

  it("skips delivery when the sentinel appears anywhere in the final message", async () => {
    const emit = createEmitStub();

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        {
          id: "text-1",
          text: `Internal preamble ${EMPTY_DELIVERY_SENTINEL} trailing text`,
          type: "text-delta",
        },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
    );

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: null }),
        type: "message.completed",
      }),
    );
  });
});

describe("emitStreamContent action requests", () => {
  it("cancels a pending provider action batch when the stream aborts", async () => {
    vi.useFakeTimers();
    const emit = createEmitStub();

    try {
      await expect(
        emitStreamContent(
          emit,
          EMISSION_STATE,
          streamOf([
            {
              input: { query: "eve" },
              providerExecuted: true,
              toolCallId: "search-1",
              toolName: "web_search",
              type: "tool-call",
            },
            { reason: "cancelled", type: "abort" },
          ] as TextStreamPart<ToolSet>[]),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });

      await vi.runAllTimersAsync();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a provider action batch before any provider result arrives", async () => {
    const events: Parameters<HarnessEmitFn>[0][] = [];
    const emit: HarnessEmitFn = async (event) => {
      events.push(event);
    };
    let releaseResults!: () => void;
    const resultsPending = new Promise<void>((resolve) => {
      releaseResults = resolve;
    });
    const searches = Array.from({ length: 10 }, (_, index) => ({
      input: { query: `tri-state-${index + 1}` },
      providerExecuted: true,
      toolCallId: `search-${index + 1}`,
      toolName: "web_search",
      type: "tool-call" as const,
    }));

    async function* controlledStream(): AsyncIterable<TextStreamPart<ToolSet>> {
      for (const call of searches) {
        yield call as TextStreamPart<ToolSet>;
      }
      await resultsPending;
      for (const call of searches) {
        yield {
          input: call.input,
          output: { results: [] },
          providerExecuted: true,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          type: "tool-result",
        } as TextStreamPart<ToolSet>;
      }
      yield { finishReason: "stop", type: "finish-step" } as TextStreamPart<ToolSet>;
    }

    const run = emitStreamContent(emit, EMISSION_STATE, controlledStream());
    try {
      await vi.waitFor(() => {
        const actionRequests = events.filter((event) => event.type === "actions.requested");
        expect(actionRequests).toHaveLength(1);
        expect(actionRequests[0]?.data.actions.map((action) => action.callId)).toEqual(
          searches.map((call) => call.toolCallId),
        );
      });
      expect(events.some((event) => event.type === "action.result")).toBe(false);
    } finally {
      releaseResults();
    }

    const streamResult = await run;
    expect([...streamResult.emittedActionCallIds]).toEqual(searches.map((call) => call.toolCallId));
  });

  it("completes pre-tool text before emitting a streamed action request", async () => {
    const emit = createEmitStub();
    const tools = new Map<string, HarnessToolDefinition>([
      [
        "delegate",
        {
          description: "Delegate work to a subagent.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "delegate",
          runtimeAction: {
            kind: "subagent-call",
            nodeId: "subagents/researcher",
            subagentName: "researcher",
          },
        },
      ],
    ]);

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "message-1", text: "Checking the release notes.", type: "text-delta" },
        {
          input: { task: "research the release" },
          toolCallId: "call-delegate",
          toolName: "delegate",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(),
        tools,
      },
    );

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    expect(events.map((event) => event.type)).toEqual([
      "message.appended",
      "message.completed",
      "actions.requested",
    ]);
    expect(events[1]).toMatchObject({
      data: { finishReason: "tool-calls", message: "Checking the release notes." },
      type: "message.completed",
    });
  });

  it("projects local and provider tool results at the same stream position", async () => {
    const tools = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          description: "Search the web.",
          execute: async () => ({ results: [] }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "web_search",
        },
      ],
    ]);
    const parts = (providerExecuted: boolean): TextStreamPart<ToolSet>[] => {
      const providerExecution: { readonly providerExecuted?: true } = providerExecuted
        ? { providerExecuted: true }
        : {};
      return [
        { id: "text-1", text: "Searching now.", type: "text-delta" },
        {
          input: { query: "eve" },
          ...providerExecution,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
        {
          output: { results: ["partial"] },
          preliminary: true,
          ...providerExecution,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
        {
          output: { results: ["eve"] },
          ...providerExecution,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-result",
        },
        { id: "text-2", text: "Done.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[];
    };
    const localEmit = createEmitStub();
    const providerEmit = createEmitStub();

    await emitStreamContent(localEmit, EMISSION_STATE, streamOf(parts(false)), {
      excludedActionToolNames: new Set(),
      tools,
    });
    await emitStreamContent(providerEmit, EMISSION_STATE, streamOf(parts(true)), {
      excludedActionToolNames: new Set(),
      tools,
    });

    const localEvents = vi.mocked(localEmit).mock.calls.map(([event]) => event);
    const providerEvents = vi.mocked(providerEmit).mock.calls.map(([event]) => event);

    expect(localEvents).toEqual(providerEvents);
    expect(localEvents.map((event) => event.type)).toEqual([
      "message.appended",
      "message.completed",
      "actions.requested",
      "action.result",
      "message.appended",
      "message.completed",
    ]);
    expect(localEvents[3]).toMatchObject({
      data: { result: { output: { results: ["eve"] } } },
      type: "action.result",
    });
  });

  it("projects local and provider tool failures at the same stream position", async () => {
    const tools = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          description: "Search the web.",
          execute: async () => ({ results: [] }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "web_search",
        },
      ],
    ]);
    const parts = (providerExecuted: boolean): TextStreamPart<ToolSet>[] => {
      const providerExecution: { readonly providerExecuted?: true } = providerExecuted
        ? { providerExecuted: true }
        : {};
      return [
        {
          input: { query: "eve" },
          ...providerExecution,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-call",
        },
        {
          error: new Error("Search failed"),
          input: { query: "eve" },
          ...providerExecution,
          toolCallId: "call-1",
          toolName: "web_search",
          type: "tool-error",
        },
        { id: "text-1", text: "I could not find a result.", type: "text-delta" },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[];
    };
    const localEmit = createEmitStub();
    const providerEmit = createEmitStub();

    const localResult = await emitStreamContent(localEmit, EMISSION_STATE, streamOf(parts(false)), {
      excludedActionToolNames: new Set(),
      tools,
    });
    const providerResult = await emitStreamContent(
      providerEmit,
      EMISSION_STATE,
      streamOf(parts(true)),
      {
        excludedActionToolNames: new Set(),
        tools,
      },
    );

    const localEvents = vi.mocked(localEmit).mock.calls.map(([event]) => event);
    const providerEvents = vi.mocked(providerEmit).mock.calls.map(([event]) => event);

    expect(localEvents).toEqual(providerEvents);
    expect(localEvents.map((event) => event.type)).toEqual([
      "actions.requested",
      "action.result",
      "message.appended",
      "message.completed",
    ]);
    expect(localEvents[1]).toMatchObject({
      data: {
        result: { callId: "call-1", isError: true, output: "Search failed" },
        status: "failed",
      },
      type: "action.result",
    });
    expect(localResult.trailingInlineToolResultParts).toEqual([
      {
        output: { type: "error-text", value: "Search failed" },
        toolCallId: "call-1",
        toolName: "web_search",
        type: "tool-result",
      },
    ]);
    expect(providerResult.trailingInlineToolResultParts).toEqual([]);
  });

  it("turns non-object tool call input into a failed tool result for the model", async () => {
    const tools = new Map<string, HarnessToolDefinition>([
      [
        "web_search",
        {
          description: "Search the web.",
          execute: async () => ({ results: [] }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "web_search",
        },
      ],
    ]);
    const emit = createEmitStub();
    const message =
      'Failed to parse tool-call arguments for "web_search" (call-bad): Expected a JSON-serializable object.';

    const result = await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        {
          input: "not an object",
          toolCallId: "call-bad",
          toolName: "web_search",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(),
        tools,
      },
    );

    const events = vi.mocked(emit).mock.calls.map(([event]) => event);
    expect(events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          error: { code: "ACTION_RESULT_FAILED", message },
          result: {
            callId: "call-bad",
            isError: true,
            kind: "tool-result",
            output: message,
            toolName: "web_search",
          },
          status: "failed",
        }),
        type: "action.result",
      }),
    ]);
    expect([...result.invalidInputToolCallIds]).toEqual(["call-bad"]);
    expect(result.trailingInlineToolResultParts).toEqual([
      {
        output: { type: "error-text", value: message },
        toolCallId: "call-bad",
        toolName: "web_search",
        type: "tool-result",
      },
    ]);
  });
});

describe("emitStreamContent error-part handling", () => {
  it("interrupts a stalled provider pull when the durable emitter fails", async () => {
    const writeError = new Error("durable write failed");
    let rejectWrite!: (error: unknown) => void;
    const firstWrite = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    let providerCancelled = false;
    let stalledReadStarted = false;
    const firstPart = {
      id: "text-1",
      text: "A",
      type: "text-delta",
    } as TextStreamPart<ToolSet>;
    const stalledStream: AsyncIterable<TextStreamPart<ToolSet>> = {
      [Symbol.asyncIterator]() {
        let reads = 0;
        return {
          next(): Promise<IteratorResult<TextStreamPart<ToolSet>>> {
            reads += 1;
            if (reads === 1) {
              return Promise.resolve({ done: false, value: firstPart });
            }
            stalledReadStarted = true;
            return new Promise(() => {});
          },
          return(): Promise<IteratorResult<TextStreamPart<ToolSet>>> {
            providerCancelled = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    const run = emitStreamContent(async () => firstWrite, EMISSION_STATE, stalledStream);
    const rejected = expect(run).rejects.toBe(writeError);
    await vi.waitFor(() => expect(stalledReadStarted).toBe(true));

    rejectWrite(writeError);

    await rejected;
    expect(providerCancelled).toBe(true);
  });

  it("preserves the original Error instance when the stream emits one", async () => {
    const original = new TypeError("upstream rejected");

    await expect(
      emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: original, type: "error" } as TextStreamPart<ToolSet>]),
      ),
    ).rejects.toBe(original);
  });

  it("surfaces the .message field of an Error-shaped plain-object throwable", async () => {
    // Structured-clone across a workflow step strips the prototype but
    // keeps the fields — the harness must not collapse this to
    // `new Error("[object Object]")`.
    const raw = { message: "upstream 503", name: "APICallError", statusCode: 503 };

    let caught: unknown;
    try {
      await emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: raw, type: "error" } as TextStreamPart<ToolSet>]),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("upstream 503");
    expect((caught as Error).name).toBe("APICallError");
  });

  it("falls back to a JSON-ish message for opaque plain-object throwables", async () => {
    // Regression guard for the user-facing
    // `"I hit an error while handling your request ([object Object])"`
    // bug caused by `new Error(String(partError))`.
    const raw = { code: "E_GATEWAY", status: 500 };

    let caught: unknown;
    try {
      await emitStreamContent(
        createEmitStub(),
        EMISSION_STATE,
        streamOf([{ error: raw, type: "error" } as TextStreamPart<ToolSet>]),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toBe("[object Object]");
    expect((caught as Error).message).toBe('{"code":"E_GATEWAY","status":500}');
  });
});
