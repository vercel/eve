import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import {
  getBlockingWorkflowToolRuns,
  registerWorkflowToolRun,
  type BlockingWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
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

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({
          session: createCancelledTurnSession([cancelled]),
        }),
      });

      expect(getTaskTable(result.sessionState.snapshot.session).records).toEqual([cancelled]);
      expect(result.sessionState.snapshot.session.outputSchema).toBeUndefined();
      expect(bindSessionInstrumentationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: "settle-cancel-handles" }),
      );
    });
  });

  it.each([false, true])(
    "removes only the cancelled turn's workflow runs (paused=%s)",
    async (paused) => {
      const runtime = await createTestRuntime({ agent: { name: "settle-turn-invocations" } });
      await runtime.run(async () => {
        const earlier: BlockingWorkflowToolRun = {
          callId: "earlier-call",
          lifetime: "turn",
          toolName: "research",
          origin: { turnId: "turn-0", stepIndex: 0 },
          address: { runId: "earlier-run", hookToken: "earlier-hook" },
        };
        let session = registerWorkflowToolRun(createCancelledTurnSession(), earlier);
        session = registerWorkflowToolRun(session, {
          callId: "waiting-call",
          toolName: "research",
          lifetime: "turn",
          origin: { turnId: "turn-1", stepIndex: 0 },
          address: { runId: "waiting-run", hookToken: "waiting-hook" },
        });
        if (paused)
          session = setPendingCoordinationBatch({
            event: { sequence: 3, stepIndex: 1, turnId: "turn-1" },
            responseMessages: [],
            tasks: [],
            session: setHarnessEmissionState(session, {
              sequence: 4,
              stepIndex: 0,
              sessionStarted: true,
              turnId: "",
            }),
          });
        const result = await settleCancelledTurnStep({
          sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
          serializedContext: buildSerializedContext(),
          sessionState: createDurableSessionState({ session }),
        });
        expect(getBlockingWorkflowToolRuns(result.sessionState.snapshot.session.state)).toEqual([
          earlier,
        ]);
      });
    },
  );
});
