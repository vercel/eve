import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { eventsOf } from "#harness/publication.js";
import { eachEvent } from "#internal/testing/session-machine.js";
import { jsonSchema, type TextStreamPart, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import { emitStreamContent } from "#harness/emission.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { resolveWebSearchActivityLabel } from "#harness/provider-tool-schemas.js";
import type { HarnessEmitFn, SessionPublication } from "#harness/types.js";

async function* streamOf(parts: TextStreamPart<ToolSet>[]): AsyncIterable<TextStreamPart<ToolSet>> {
  for (const part of parts) {
    yield part;
  }
}

const EMISSION_STATE: TurnPosition = {
  sequence: 0,
  sessionStarted: true,
  stepIndex: 0,
  turnId: "turn_0",
};

function createEmitStub(): HarnessEmitFn {
  return vi.fn(async () => {});
}

describe("emitStreamContent empty delivery", () => {
  it("reduces 368 saturated deltas to eight bounded dispatches", async () => {
    const deltaCount = 368;
    const writeReleases: Array<() => void> = [];
    let providerDeltas = 0;
    let providerFinished = false;
    const emit = vi.fn(async (_publication: SessionPublication) => {
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

    const events = vi.mocked(emit).mock.calls.flatMap(([publication]) => eventsOf(publication));
    const appended = events.filter((event) => event.type === "message.appended");
    expect(providerFinished).toBe(true);
    expect(events).toHaveLength(8);
    expect(appended.map((event) => event.data.messageDelta.length)).toEqual([
      1, 64, 64, 64, 64, 64, 47,
    ]);
    expect(appended.reduce((total, event) => total + event.data.messageDelta.length, 0)).toBe(
      deltaCount,
    );
    expect(events.at(-1)?.type).toBe("message.completed");
  });
});

describe("emitStreamContent action requests", () => {
  it("streams a visible action input lifecycle before the completed request", async () => {
    const emit = createEmitStub();
    const tools = new Map<string, HarnessToolDefinition>([
      [
        "render",
        {
          description: "Render a JSON document.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "render",
        },
      ],
    ]);

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "call-render", toolName: "render", type: "tool-input-start" },
        { delta: '{"title":"Hel', id: "call-render", type: "tool-input-delta" },
        { delta: 'lo"}', id: "call-render", type: "tool-input-delta" },
        { id: "call-render", type: "tool-input-end" },
        {
          input: { title: "Hello" },
          toolCallId: "call-render",
          toolName: "render",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(),
        tools,
      },
    );

    const events = vi.mocked(emit).mock.calls.flatMap(([publication]) => eventsOf(publication));
    expect(events.map((event) => event.type)).toEqual([
      "action.input.appended",
      "action.input.appended",
      "actions.requested",
    ]);
    const inputEvents = events.filter((event) => event.type === "action.input.appended");
    expect(inputEvents.map((event) => event.data)).toEqual([
      {
        callId: "call-render",
        inputTextDelta: '{"title":"Hel',
        sequence: 0,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_0",
      },
      {
        callId: "call-render",
        inputTextDelta: 'lo"}',
        sequence: 0,
        stepIndex: 0,
        toolName: "render",
        turnId: "turn_0",
      },
    ]);
  });

  it("does not expose streamed input for excluded actions", async () => {
    const emit = createEmitStub();

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "call-hidden", toolName: "hidden", type: "tool-input-start" },
        { delta: '{"secret":true}', id: "call-hidden", type: "tool-input-delta" },
        { id: "call-hidden", type: "tool-input-end" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(["hidden"]),
        tools: new Map(),
      },
    );

    expect(emit).not.toHaveBeenCalled();
  });

  it("does not expose streamed input for provider-executed actions", async () => {
    const emit = createEmitStub();

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        {
          id: "call-provider",
          providerExecuted: true,
          toolName: "web_search",
          type: "tool-input-start",
        },
        { delta: '{"query":"eve"}', id: "call-provider", type: "tool-input-delta" },
        { id: "call-provider", type: "tool-input-end" },
      ] as TextStreamPart<ToolSet>[]),
      { excludedActionToolNames: new Set(), tools: new Map() },
    );

    expect(emit).not.toHaveBeenCalled();
  });

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

  it("emits tool labels for provider-executed calls", async () => {
    const emitted: UnstampedMessageStreamEvent[] = [];
    const emit: HarnessEmitFn = eachEvent(async (event) => {
      emitted.push(event);
    });

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        {
          input: { action: { queries: ["eve framework"] } },
          providerExecuted: true,
          toolCallId: "search-1",
          toolName: "web_search",
          type: "tool-call",
        },
        { finishReason: "stop", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(),
        tools: new Map([
          [
            "web_search",
            {
              label: { start: resolveWebSearchActivityLabel },
              description: "Search the web.",
              inputSchema: jsonSchema({ type: "object" }),
              name: "web_search",
            },
          ],
        ]),
      },
    );

    expect(emitted.find((event) => event.type === "actions.requested")?.data.presentation).toEqual({
      "search-1": { label: "Search eve framework" },
    });
  });

  it("emits a provider action batch before any provider result arrives", async () => {
    const events: UnstampedMessageStreamEvent[] = [];
    const emit: HarnessEmitFn = eachEvent(async (event) => {
      events.push(event);
    });
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

    await run;
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
          workflowId: "workflow//./agent/subagents/researcher//execute",
        },
      ],
    ]);

    await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        { id: "message-1", text: "Checking the release notes.", type: "text-delta" },
        { id: "call-delegate", toolName: "delegate", type: "tool-input-start" },
        { delta: '{"task":"research the release"}', id: "call-delegate", type: "tool-input-delta" },
        { id: "call-delegate", type: "tool-input-end" },
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

    const events = vi.mocked(emit).mock.calls.flatMap(([publication]) => eventsOf(publication));
    expect(events.map((event) => event.type)).toEqual([
      "message.appended",
      "message.completed",
      "action.input.appended",
      "actions.requested",
    ]);
    expect(events[1]).toMatchObject({
      data: { finishReason: "tool-calls", message: "Checking the release notes." },
      type: "message.completed",
    });
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
          input: '"not an object"',
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

    const events = vi.mocked(emit).mock.calls.flatMap(([publication]) => eventsOf(publication));
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

  it("turns malformed provider-executed tool call input into a failed tool result", async () => {
    const emit = createEmitStub();

    const result = await emitStreamContent(
      emit,
      EMISSION_STATE,
      streamOf([
        {
          // Opus 5 has emitted syntactically invalid JSON for provider
          // web_search arguments: an unquoted bare value.
          input: '{"objective": "Find the champion.", "search_queries": 2025 NBA Finals}',
          providerExecuted: true,
          toolCallId: "call-bad",
          toolName: "web_search",
          type: "tool-call",
        },
        { finishReason: "tool-calls", type: "finish-step" },
      ] as TextStreamPart<ToolSet>[]),
      {
        excludedActionToolNames: new Set(),
        tools: new Map<string, HarnessToolDefinition>(),
      },
    );

    const events = vi.mocked(emit).mock.calls.flatMap(([publication]) => eventsOf(publication));
    const actionResult = events.find((event) => event.type === "action.result");
    if (actionResult?.data.error === undefined) {
      throw new Error("Expected a failed action.result event.");
    }
    const { message } = actionResult.data.error;
    expect(message).toMatch(/Failed to parse tool-call arguments for "web_search" \(call-bad\):/u);
    expect(message).not.toContain("Expected a JSON-serializable object.");
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
