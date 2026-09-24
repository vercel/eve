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
import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  getAgentHandleStore,
  type AgentHandle,
} from "#subagents/handles/store.js";
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

/**
 * The cancellation epilogue is the last write that can move a cancelled
 * child's handle: `cancelDescendantTurnsStep` only requests cancellation,
 * and the turn inbox a child settlement would resume is torn down with the
 * cancelled turn. These tests pin the persisted handle store the epilogue
 * leaves behind — a `running` handle surviving here would be permanent.
 */

const PARENT_SESSION_ID = "parent-session-cancel-handles";
const CONTINUATION_TOKEN = "http:settle-cancel-handles";

const RUNNING_OPERATION_ID = deriveAgentOperationId({
  callId: "call-1",
  parentSessionId: PARENT_SESSION_ID,
  parentTurnId: "turn-1",
});

const RUNNING_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:child-running",
    kind: "agent/local",
    sessionId: "child-session-running",
  },
  identity: {
    id: deriveAgentId("research", RUNNING_OPERATION_ID),
    name: "research",
    nodeId: "subagents/research",
  },
  operation: {
    callId: "call-1",
    id: RUNNING_OPERATION_ID,
    kind: "start",
    parentTurnId: "turn-1",
  },
  phase: "running",
};

const PARKED_OPERATION_ID = deriveAgentOperationId({
  callId: "call-0",
  parentSessionId: PARENT_SESSION_ID,
  parentTurnId: "turn-0",
});

const PARKED_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:child-parked",
    kind: "agent/local",
    sessionId: "child-session-parked",
  },
  identity: {
    id: deriveAgentId("writer", PARKED_OPERATION_ID),
    name: "writer",
    nodeId: "subagents/writer",
  },
  lastStatus: "draft ready",
  phase: "parked",
};

const CLAIMED_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:child-claimed",
    kind: "agent/local",
    sessionId: "child-session-claimed",
  },
  callId: "workflow-call",
  identity: {
    id: "ag_research:workflow",
    name: "research",
    nodeId: "subagents/research",
  },
  operationId: "workflow-operation",
  ownerId: "workflow-run",
  phase: "claimed",
};

function createCancelledTurnSession(handles: readonly AgentHandle[]): HarnessSession {
  return setHarnessEmissionState(
    {
      agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: CONTINUATION_TOKEN,
      history: [],
      outputSchema: { type: "object" },
      sessionId: PARENT_SESSION_ID,
      state: { [AGENT_HANDLES_STATE_KEY]: { handles } },
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

describe("settleCancelledTurnStep handle store", () => {
  it("parks abandoned running handles as cancelled and keeps parked ones", async () => {
    bindSessionInstrumentationSpy.mockClear();
    const runtime = await createTestRuntime({ agent: { name: "settle-cancel-handles" } });

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({
          session: createCancelledTurnSession([RUNNING_HANDLE, PARKED_HANDLE]),
        }),
      });

      expect(getAgentHandleStore(result.sessionState.snapshot.session.state)).toEqual({
        handles: [
          {
            address: RUNNING_HANDLE.address,
            identity: RUNNING_HANDLE.identity,
            lastStatus: "(cancelled)",
            phase: "parked",
          },
          PARKED_HANDLE,
        ],
      });
      expect(result.sessionState.snapshot.session.outputSchema).toBeUndefined();
      expect(bindSessionInstrumentationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: "settle-cancel-handles" }),
      );
    });
  });

  it("releases a cancelled workflow claim with a resumable cancelled status", async () => {
    const runtime = await createTestRuntime({ agent: { name: "settle-cancel-claim" } });

    await runtime.run(async () => {
      const session = registerWorkflowToolRun(createCancelledTurnSession([CLAIMED_HANDLE]), {
        callId: "workflow-call",
        toolName: "Workflow",
        lifetime: "turn" as const,
        origin: { turnId: "turn-1", stepIndex: 0 },
        address: { runId: "workflow-run", hookToken: "workflow-hook" },
      });
      const result = await settleCancelledTurnStep({
        sessionWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({ session }),
      });

      expect(getAgentHandleStore(result.sessionState.snapshot.session.state)).toEqual({
        handles: [
          {
            address: CLAIMED_HANDLE.address,
            identity: CLAIMED_HANDLE.identity,
            lastStatus: "(cancelled)",
            phase: "parked",
          },
        ],
      });
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
        let session = registerWorkflowToolRun(createCancelledTurnSession([]), earlier);
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
