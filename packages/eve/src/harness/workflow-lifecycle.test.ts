import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { createWorkflowLifecycle } from "#harness/workflow-lifecycle.js";
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
      "researcher",
      {
        description: "Delegate to the researcher.",
        inputSchema: jsonSchema({ type: "object" }),
        name: "researcher",
        runtimeAction: {
          kind: "subagent-call",
          nodeId: "subagents/researcher",
          subagentName: "researcher",
        },
      },
    ],
  ]);
}

function nestedCall(replayed = false) {
  return {
    bridgeIndex: 1,
    input: { message: "Investigate" },
    inputBytes: 24,
    invocationId: "workflow-1",
    outerToolCallId: "outer-call",
    replayed,
    startedAtMs: 10,
    toolCallId: "outer-call:tool-1",
    toolName: "researcher",
  };
}

describe("createWorkflowLifecycle", () => {
  it("emits nested subagent calls and results as action events", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createWorkflowLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      tools: createTools(),
    });

    await lifecycle.onNestedToolCall?.(nestedCall());
    await lifecycle.onNestedToolResult?.({
      ...nestedCall(),
      completedAtMs: 20,
      durationMs: 10,
      output: { value: "ok" },
      outputBytes: 14,
      status: "fulfilled",
    });

    expect(events[0]).toMatchObject({
      data: {
        actions: [
          {
            callId: "outer-call:tool-1",
            kind: "subagent-call",
            subagentName: "researcher",
          },
        ],
        sequence: 2,
        stepIndex: 3,
        turnId: "turn_abc",
      },
      type: "actions.requested",
    });
    expect(events[1]).toMatchObject({
      data: {
        result: {
          callId: "outer-call:tool-1",
          output: { value: "ok" },
          toolName: "researcher",
        },
      },
      type: "action.result",
    });
  });

  it("projects rejected child results through the shared result contract", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createWorkflowLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      tools: createTools(),
    });

    await lifecycle.onNestedToolResult?.({
      ...nestedCall(),
      completedAtMs: 20,
      durationMs: 10,
      error: new Error("child failed"),
      status: "rejected",
    });

    expect(events[0]).toMatchObject({
      data: {
        result: { isError: true, output: "child failed" },
        status: "failed",
      },
      type: "action.result",
    });
  });

  it("skips replayed calls during continuation", async () => {
    const events: HandleMessageStreamEvent[] = [];
    const lifecycle = createWorkflowLifecycle({
      emit: async (event) => {
        events.push(event);
      },
      emissionState,
      skipReplayed: true,
      tools: createTools(),
    });

    await lifecycle.onNestedToolCall?.(nestedCall(true));
    expect(events).toEqual([]);
  });

  it("dispatches lifecycle events in the invoking context", async () => {
    const lifecycleDispatches = defineState<string[]>(
      "test.workflow.lifecycle.dispatch-context",
      () => [],
    );
    const buildSession = new ContextContainer();
    const callSession = new ContextContainer();
    const lifecycle = await contextStorage.run(buildSession, async () =>
      createWorkflowLifecycle({
        emit: async (event) => {
          lifecycleDispatches.update((events) => [...events, event.type]);
        },
        emissionState,
        tools: createTools(),
      }),
    );

    await contextStorage.run(callSession, () => lifecycle.onNestedToolCall?.(nestedCall()));

    expect(contextStorage.run(callSession, () => lifecycleDispatches.get())).toEqual([
      "actions.requested",
    ]);
    expect(contextStorage.run(buildSession, () => lifecycleDispatches.get())).toEqual([]);
  });
});
