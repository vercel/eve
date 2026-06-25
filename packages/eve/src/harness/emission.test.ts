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
  it("emits each normal text delta before reading the next stream part", async () => {
    const emit = createEmitStub();
    let releaseSecondPart!: () => void;
    const secondPartReady = new Promise<void>((resolve) => {
      releaseSecondPart = resolve;
    });
    async function* controlledStream(): AsyncIterable<TextStreamPart<ToolSet>> {
      yield { id: "text-1", text: "first", type: "text-delta" } as TextStreamPart<ToolSet>;
      await secondPartReady;
      yield { id: "text-1", text: " second", type: "text-delta" } as TextStreamPart<ToolSet>;
      yield { finishReason: "stop", type: "finish-step" } as TextStreamPart<ToolSet>;
    }

    const run = emitStreamContent(emit, EMISSION_STATE, controlledStream());
    try {
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
      expect(vi.mocked(emit).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({ messageDelta: "first", messageSoFar: "first" }),
          type: "message.appended",
        }),
      );
    } finally {
      releaseSecondPart();
      await run;
    }
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
});

describe("emitStreamContent error-part handling", () => {
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
