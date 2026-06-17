import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { createCodeModeLifecycle } from "#harness/code-mode-lifecycle.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { HarnessToolMap } from "#harness/types.js";
import { defineState } from "#public/definitions/state.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const emissionState: HarnessEmissionState = {
  sequence: 2,
  sessionStarted: true,
  stepIndex: 3,
  turnId: "turn_abc",
};

function createTools(): HarnessToolMap {
  return new Map([
    [
      "lookup",
      {
        description: "Lookup data.",
        execute: async () => ({ ok: true }),
        inputSchema: jsonSchema({ type: "object" }),
        name: "lookup",
      },
    ],
  ]);
}

describe("createCodeModeLifecycle", () => {
  it("emits nested tool calls and results as eve action events", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createCodeModeLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      tools: createTools(),
    });

    await lifecycle.onNestedToolCall?.({
      bridgeIndex: 1,
      input: { id: "123" },
      inputBytes: 12,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      replayed: false,
      startedAtMs: 10,
      toolCallId: "outer-call:tool-1",
      toolName: "lookup",
    });
    await lifecycle.onNestedToolResult?.({
      bridgeIndex: 1,
      completedAtMs: 20,
      durationMs: 10,
      input: { id: "123" },
      inputBytes: 12,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      output: { value: "ok" },
      outputBytes: 14,
      replayed: false,
      startedAtMs: 10,
      status: "fulfilled",
      toolCallId: "outer-call:tool-1",
      toolName: "lookup",
    });

    expect(events).toEqual([
      {
        data: {
          actions: [
            {
              callId: "outer-call:tool-1",
              input: { id: "123" },
              kind: "tool-call",
              toolName: "lookup",
            },
          ],
          sequence: 2,
          stepIndex: 3,
          turnId: "turn_abc",
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "outer-call:tool-1",
            kind: "tool-result",
            output: { value: "ok" },
            toolName: "lookup",
          },
          sequence: 2,
          status: "completed",
          stepIndex: 3,
          turnId: "turn_abc",
        },
        type: "action.result",
      },
    ]);
  });

  it("projects a rejected nested result through the shared action-result helper", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createCodeModeLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      tools: createTools(),
    });

    await lifecycle.onNestedToolResult?.({
      bridgeIndex: 1,
      completedAtMs: 20,
      durationMs: 10,
      error: new Error("lookup boom"),
      input: { id: "123" },
      inputBytes: 12,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      replayed: false,
      startedAtMs: 10,
      status: "rejected",
      toolCallId: "outer-call:tool-1",
      toolName: "lookup",
    });

    expect(events).toEqual([
      {
        data: {
          error: {
            code: "ACTION_RESULT_FAILED",
            message: "lookup boom",
          },
          result: {
            callId: "outer-call:tool-1",
            isError: true,
            kind: "tool-result",
            output: "lookup boom",
            toolName: "lookup",
          },
          sequence: 2,
          status: "failed",
          stepIndex: 3,
          turnId: "turn_abc",
        },
        type: "action.result",
      },
    ]);
  });

  it("emits raw nested output structurally without re-validating it", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createCodeModeLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      tools: createTools(),
    });

    const rawOutput = { nested: { items: [1, 2, 3] }, summary: "ok" };
    await lifecycle.onNestedToolResult?.({
      bridgeIndex: 1,
      completedAtMs: 20,
      durationMs: 10,
      input: {},
      inputBytes: 2,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      output: rawOutput,
      outputBytes: 30,
      replayed: false,
      startedAtMs: 10,
      status: "fulfilled",
      toolCallId: "outer-call:tool-1",
      toolName: "lookup",
    });

    const [event] = events;
    if (event?.type !== "action.result") {
      throw new Error("expected an action.result event");
    }
    expect(event.data.result).toEqual({
      callId: "outer-call:tool-1",
      kind: "tool-result",
      output: rawOutput,
      toolName: "lookup",
    });
  });

  it("skips replayed nested calls during continuation replay", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createCodeModeLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      skipReplayed: true,
      tools: createTools(),
    });

    await lifecycle.onNestedToolCall?.({
      bridgeIndex: 1,
      input: { id: "old" },
      inputBytes: 12,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      replayed: true,
      startedAtMs: 10,
      toolCallId: "outer-call:tool-1",
      toolName: "lookup",
    });
    await lifecycle.onNestedToolCall?.({
      bridgeIndex: 2,
      input: { id: "new" },
      inputBytes: 12,
      invocationId: "code-mode-1",
      outerToolCallId: "outer-call",
      replayed: false,
      startedAtMs: 20,
      toolCallId: "outer-call:tool-2",
      toolName: "lookup",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      data: {
        actions: [
          {
            callId: "outer-call:tool-2",
            input: { id: "new" },
            kind: "tool-call",
            toolName: "lookup",
          },
        ],
      },
      type: "actions.requested",
    });
  });

  it("dispatches lifecycle events under the invoking context, not the build-time one", async () => {
    // experimental-ai-sdk-code-mode >= 1.0.11 re-enters the originating
    // invocation's context at the worker bridge before invoking these hooks, so
    // the lifecycle is context-transparent: `defineState` writes land in the
    // session active when the hook runs, not the one active when it was built.
    const lifecycleDispatches = defineState<string[]>(
      "test.code-mode.lifecycle.dispatch-context",
      () => [],
    );
    const buildSession = new ContextContainer();
    const callSession = new ContextContainer();

    const lifecycle = await contextStorage.run(buildSession, async () =>
      createCodeModeLifecycle({
        emit: async (event) => {
          lifecycleDispatches.update((events) => [...events, event.type]);
        },
        emissionState,
        tools: createTools(),
      }),
    );

    await contextStorage.run(callSession, async () => {
      await lifecycle.onNestedToolCall?.({
        bridgeIndex: 1,
        input: { id: "123" },
        inputBytes: 12,
        invocationId: "code-mode-1",
        outerToolCallId: "outer-call",
        replayed: false,
        startedAtMs: 10,
        toolCallId: "outer-call:tool-1",
        toolName: "lookup",
      });
      await lifecycle.onNestedToolResult?.({
        bridgeIndex: 1,
        completedAtMs: 20,
        durationMs: 10,
        input: { id: "123" },
        inputBytes: 12,
        invocationId: "code-mode-1",
        outerToolCallId: "outer-call",
        output: { value: "ok" },
        outputBytes: 14,
        replayed: false,
        startedAtMs: 10,
        status: "fulfilled",
        toolCallId: "outer-call:tool-1",
        toolName: "lookup",
      });
    });

    expect(contextStorage.run(callSession, () => lifecycleDispatches.get())).toEqual([
      "actions.requested",
      "action.result",
    ]);
    expect(contextStorage.run(buildSession, () => lifecycleDispatches.get())).toEqual([]);
  });

  it("state written by an action.result handler is visible to a subsequent tool in the invocation context", async () => {
    // Mirrors a production SQL flow: execute_sql → action.result hook writes
    // latestSql → finalize_answer reads latestSql. The package re-enters the
    // originating invocation's context (invocationSession) at the worker bridge
    // before dispatching execute and lifecycle hooks, so all three run under it
    // regardless of which session built the tools/lifecycle. State written by
    // the hook must therefore be visible to the next tool, and isolated from an
    // unrelated session (otherSession).
    const latestSql = defineState<string | null>("test.code-mode.latest-sql", () => null);

    const otherSession = new ContextContainer();
    const invocationSession = new ContextContainer();

    const tools: HarnessToolMap = new Map([
      [
        "execute_sql",
        {
          description: "Run SQL.",
          execute: async () => ({ appliedSql: "SELECT 1" }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "execute_sql",
        },
      ],
      [
        "finalize_answer",
        {
          description: "Finalize.",
          execute: async () => {
            const sql = latestSql.get();
            return { capturedSql: sql };
          },
          inputSchema: jsonSchema({ type: "object" }),
          name: "finalize_answer",
        },
      ],
    ]);

    // Tools and lifecycle can be built under any session; the wrapper and
    // lifecycle are context-transparent.
    const { hostTools, lifecycle } = await contextStorage.run(otherSession, async () => {
      const { buildToolSet } = await import("#harness/tools.js");
      const { applySandboxToolSet } = await import("#harness/code-mode.js");
      const { CODE_MODE_SURFACE } = await import("#harness/sandbox-surface.js");
      const flatTools = buildToolSet({ tools });
      const { hostTools } = await applySandboxToolSet({
        harnessTools: tools,
        tools: flatTools,
        surfaces: [CODE_MODE_SURFACE],
      });

      const lifecycle = createCodeModeLifecycle({
        emit: async (event) => {
          // Simulate the action.result hook writing state, like a production agent's
          // turn-metrics hook captures appliedSql.
          if (event.type === "action.result") {
            const result = (event.data as { result: { toolName: string; output: unknown } }).result;
            if (result.toolName === "execute_sql") {
              const output = result.output as { appliedSql?: string };
              if (typeof output?.appliedSql === "string") {
                latestSql.update(() => output.appliedSql!);
              }
            }
          }
        },
        emissionState,
        tools,
      });

      return { hostTools, lifecycle };
    });

    // The bridge handler runs every callback under the re-entered invocation
    // context — the guarantee the package provides on eve's behalf.
    const result = await contextStorage.run(invocationSession, async () => {
      // 1. execute_sql runs under the invocation context.
      const executeSql = hostTools.execute_sql as {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      };
      await executeSql.execute({}, { messages: [], toolCallId: "call_1" });

      // 2. Lifecycle fires action.result; the hook writes latestSql.
      await lifecycle.onNestedToolResult?.({
        bridgeIndex: 1,
        completedAtMs: 20,
        durationMs: 10,
        input: {},
        inputBytes: 2,
        invocationId: "inv-1",
        outerToolCallId: "outer-1",
        output: { appliedSql: "SELECT 1" },
        outputBytes: 30,
        replayed: false,
        startedAtMs: 10,
        status: "fulfilled",
        toolCallId: "call_1",
        toolName: "execute_sql",
      });

      // 3. finalize_answer reads latestSql back from the same context.
      const finalizeAnswer = hostTools.finalize_answer as {
        execute: (input: unknown, options: unknown) => Promise<unknown>;
      };
      return finalizeAnswer.execute({}, { messages: [], toolCallId: "call_2" });
    });

    expect(result).toEqual({ capturedSql: "SELECT 1" });
    expect(contextStorage.run(invocationSession, () => latestSql.get())).toBe("SELECT 1");
    expect(contextStorage.run(otherSession, () => latestSql.get())).toBeNull();
  });

  it("state written by a hook is visible to a post-step channel handler in the invocation context", async () => {
    // Mirrors a production turn.completed handler reading pendingFinalAnswer after the
    // code-mode step finishes. The package re-enters the invocation context
    // (invocationSession) before the bridge dispatches the hook, so the write
    // lands there and a later channel handler reading in the step scope sees it.
    const pendingAnswer = defineState<string | null>("test.code-mode.pending-answer", () => null);

    const otherSession = new ContextContainer();
    const invocationSession = new ContextContainer();

    const lifecycle = await contextStorage.run(otherSession, async () =>
      createCodeModeLifecycle({
        emit: async (event) => {
          if (event.type === "action.result") {
            pendingAnswer.update(() => "42 active users");
          }
        },
        emissionState,
        tools: createTools(),
      }),
    );

    // Bridge handler fires under the re-entered invocation context.
    await contextStorage.run(invocationSession, async () => {
      await lifecycle.onNestedToolResult?.({
        bridgeIndex: 1,
        completedAtMs: 20,
        durationMs: 10,
        input: {},
        inputBytes: 2,
        invocationId: "inv-1",
        outerToolCallId: "outer-1",
        output: { answer: "42" },
        outputBytes: 14,
        replayed: false,
        startedAtMs: 10,
        status: "fulfilled",
        toolCallId: "call_1",
        toolName: "finalize_answer",
      });
    });

    // Channel handler reads in the invocation scope (the step scope).
    const readInInvocation = contextStorage.run(invocationSession, () => pendingAnswer.get());
    const readInOther = contextStorage.run(otherSession, () => pendingAnswer.get());

    expect(readInInvocation).toBe("42 active users");
    expect(readInOther).toBeNull();
  });
});
