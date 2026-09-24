import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { createTaskRecord, taskTableState } from "#internal/testing/task-records.js";
import type { TaskRecord } from "#tasks/record.js";
import { getTaskTable } from "#tasks/state.js";
import type { HarnessSession } from "#harness/types.js";

const bindSessionInstrumentationSpy = vi.hoisted(() => vi.fn());
vi.mock("#instrumentation/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#instrumentation/runtime.js")>();
  return {
    ...actual,
    bindSessionInstrumentation(input: Parameters<typeof actual.bindSessionInstrumentation>[0]) {
      bindSessionInstrumentationSpy(input);
      return actual.bindSessionInstrumentation(input);
    },
  };
});

const PARENT_SESSION_ID = "parent-session-cancel-handles";
const CONTINUATION_TOKEN = "http:settle-cancel-handles";

function createCancelledTurnSession(records: readonly TaskRecord[] = []): HarnessSession {
  return setHarnessEmissionState(
    {
      agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: CONTINUATION_TOKEN,
      history: [],
      outputSchema: { type: "object" },
      sessionId: PARENT_SESSION_ID,
      state: records.length === 0 ? undefined : taskTableState(records),
    },
    { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
  );
}

function buildSerializedContext(): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": CONTINUATION_TOKEN,
    "eve.mode": "conversation",
    "eve.sessionId": PARENT_SESSION_ID,
  };
}

describe("settleCancelledTurnStep", () => {
  it("clears the turn's output schema and leaves the task table to the owner", async () => {
    bindSessionInstrumentationSpy.mockClear();
    const runtime = await createTestRuntime({ agent: { name: "settle-cancel-handles" } });
    const cancelled = createTaskRecord({
      child: { continuationToken: "subagent:child", kind: "local", sessionId: "child-session" },
      delivered: true,
      status: "cancelled",
    });
    const cancelledWorkflowCall = createTaskRecord({
      callId: "call-2",
      cancelConfirmBy: "2026-09-24T14:00:30.000Z",
      child: { commandToken: "control-hook", kind: "workflow", runId: "workflow-run" },
      delivered: true,
      id: "deploy-abc234",
      kind: "workflow",
      name: "deploy",
      status: "cancelled",
    });

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({
          session: createCancelledTurnSession([cancelled, cancelledWorkflowCall]),
        }),
      });

      expect(getTaskTable(result.sessionState.snapshot.session).records).toEqual([
        cancelled,
        cancelledWorkflowCall,
      ]);
      expect(result.sessionState.snapshot.session.outputSchema).toBeUndefined();
      expect(bindSessionInstrumentationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: "settle-cancel-handles" }),
      );
    });
  });

  it.each([
    ["no second boundary once a task's request ended", { endedByTaskInput: true as const }, []],
    ["a boundary when nothing else ended", {}, ["turn.cancelled", "session.waiting"]],
  ])("streams %s the cancelled turn's stream", async (_label, flag, expected) => {
    // Alice's background notes task asked mid-turn, which ended the turn's stream.
    const runtime = await createTestRuntime({ agent: { name: "settle-cancel-handles" } });
    const between = { sequence: 4, sessionStarted: true, stepIndex: 0, turnId: "", ...flag };
    const session = setHarnessEmissionState(createCancelledTurnSession(), between);
    const chunks: string[] = [];

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({
          write: (chunk) => void chunks.push(new TextDecoder().decode(chunk)),
        }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({ session }),
      });

      expect(chunks.map((chunk) => (JSON.parse(chunk) as { type: string }).type)).toEqual(expected);
      expect(result.sessionState.emissionState.turnId).toBe("");
    });
  });
});
