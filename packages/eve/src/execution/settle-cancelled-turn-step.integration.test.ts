import { describe, expect, it, vi } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { setPendingCoordinationBatch } from "#harness/coordination.js";
import {
  getWorkflowToolRuns,
  registerWorkflowToolRun,
  type BackgroundWorkflowToolRun,
} from "#harness/workflow-tool-runs.js";
import { deriveAgentOperationId } from "#subagents/registry/operation-id.js";
import {
  AGENT_REGISTRY_STATE_KEY,
  deriveAgentId,
  getAgentRegistryState,
  type AgentRegistryEntry,
} from "#subagents/registry/state.js";
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

const RUNNING_HANDLE: AgentRegistryEntry = {
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

const PARKED_HANDLE: AgentRegistryEntry = {
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

const CLAIMED_HANDLE: AgentRegistryEntry = {
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

function createCancelledTurnSession(handles: readonly AgentRegistryEntry[]): HarnessSession {
  return setHarnessEmissionState(
    {
      agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: CONTINUATION_TOKEN,
      history: [],
      outputSchema: { type: "object" },
      sessionId: PARENT_SESSION_ID,
      state: { [AGENT_REGISTRY_STATE_KEY]: { handles } },
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

describe("settleCancelledTurnStep agent registry", () => {
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

      expect(getAgentRegistryState(result.sessionState.snapshot.session.state)).toEqual({
        registrationsInitialized: true,
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

      expect(getAgentRegistryState(result.sessionState.snapshot.session.state)).toEqual({
        registrationsInitialized: true,
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
    "retains task payloads on turn cancellation (paused=%s)",
    async (paused) => {
      const runtime = await createTestRuntime({ agent: { name: "settle-mixed-invocations" } });
      await runtime.run(async () => {
        const background: BackgroundWorkflowToolRun = {
          callId: "background-call",
          lifetime: "session",
          toolName: "research",
          origin: { turnId: "turn-1", stepIndex: 0 },
          address: { runId: "background-run", hookToken: "background-hook" },
          task: {
            taskId: "background-task",
            metadata: { kind: "tool", name: "research" },
            dispatchContext: { auth: { current: null, initiator: null } },
          },
        };
        let session = registerWorkflowToolRun(createCancelledTurnSession([]), background);
        session = registerWorkflowToolRun(session, {
          ...background,
          callId: "completed-call",
          task: {
            ...background.task,
            taskId: "completed-task",
            outcome: {
              status: "completed",
              lastOutput: { type: "result", data: "retained output" },
            },
          },
        });
        const tasks = getWorkflowToolRuns(session.state);
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
            runtimeActions: [],
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
        expect(getWorkflowToolRuns(result.sessionState.snapshot.session.state)).toEqual(tasks);
      });
    },
  );
});
