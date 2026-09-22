import { describe, expect, it } from "vitest";

import { deriveAgentOperationId } from "#subagents/handles/operation-id.js";
import {
  EMPTY_AGENT_HANDLE_STORE,
  deriveAgentId,
  getAgentHandleStore,
  writeHandles,
  type AgentAddress,
  type AgentHandle,
  type AgentIdentity,
  type StartOperation,
  type TaskOwnedAgentHandle,
} from "#subagents/handles/store.js";
import {
  abandonAgentInvocationOwners,
  abandonRunningAgentTurns,
  applyAgentHandleStoreCommand,
  confirmAgentStarted,
  prepareAgentStart,
  rejectAgentEffect,
  settleAgentTurn,
} from "#subagents/handles/transitions.js";
import type { HarnessSession } from "#harness/types.js";
import type { TokenUsage } from "#shared/token-usage.js";

const ZERO_USAGE: TokenUsage = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
};

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_test" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_test",
    history: [],
    sessionId: "session_parent",
    state,
  };
}

const startOperation: StartOperation = {
  callId: "call_1",
  id: deriveAgentOperationId({
    callId: "call_1",
    parentSessionId: "session_parent",
    parentTurnId: "turn_1",
  }),
  kind: "start",
  parentTurnId: "turn_1",
};

const identity: AgentIdentity = {
  id: deriveAgentId("research", startOperation.id),
  name: "research",
  nodeId: "node_research",
};

const address: AgentAddress = {
  continuationToken: "continuation_child",
  kind: "agent/local",
  sessionId: "session_child",
};

function preparedSession(): HarnessSession {
  return prepareAgentStart(createSession(), {
    identity,
    operation: startOperation,
    target: { continuationToken: "continuation_child", kind: "agent/local" },
  });
}

function runningSession(): HarnessSession {
  return confirmAgentStarted(preparedSession(), {
    address,
    operationId: startOperation.id,
  });
}

function parkedSession(): HarnessSession {
  const settled = settleAgentTurn(runningSession(), {
    operationId: startOperation.id,
    outcome: {
      kind: "parked",
      result: { kind: "succeeded", output: "initial findings" },
      usageDelta: ZERO_USAGE,
    },
  });
  if (settled.kind !== "settled") {
    throw new Error("expected settled");
  }
  return settled.session;
}

function handlesOf(session: HarnessSession): readonly AgentHandle[] {
  return getAgentHandleStore(session.state)?.handles ?? [];
}

describe("prepareAgentStart", () => {
  it("records starting ownership before any side effect", () => {
    const session = preparedSession();
    expect(handlesOf(session)).toEqual([
      {
        identity,
        operation: startOperation,
        phase: "starting",
        target: { continuationToken: "continuation_child", kind: "agent/local" },
      },
    ]);
  });

  it("throws when the identity already exists", () => {
    expect(() =>
      prepareAgentStart(preparedSession(), {
        identity,
        operation: startOperation,
        target: { continuationToken: "continuation_child", kind: "agent/local" },
      }),
    ).toThrow(identity.id);
  });
});

describe("confirmAgentStarted", () => {
  it("moves starting to running with the confirmed address", () => {
    expect(handlesOf(runningSession())).toEqual([
      { address, identity, operation: startOperation, phase: "running" },
    ]);
  });

  it("is a replay no-op when the handle is already running", () => {
    const running = runningSession();
    expect(confirmAgentStarted(running, { address, operationId: startOperation.id })).toBe(running);
  });

  it("throws for an operation that was never prepared", () => {
    expect(() =>
      confirmAgentStarted(createSession(), { address, operationId: "op_unprepared" }),
    ).toThrow("op_unprepared");
  });
});

describe("rejectAgentEffect", () => {
  it("deletes a dead start", () => {
    const session = rejectAgentEffect(preparedSession(), {
      disposition: "dead",
      operationId: startOperation.id,
    });
    expect(handlesOf(session)).toEqual([]);
  });

  it("restores parked with the previous status for a retryable continuation", () => {
    const continueOperation = {
      callId: "call_2",
      id: "op_continue",
      kind: "continue",
      parentTurnId: "turn_2",
      previousStatus: "initial findings",
    } as const;
    const prepared = {
      session: writeHandles(parkedSession(), [
        { address, identity, operation: continueOperation, phase: "running" },
      ]),
    };

    const restored = rejectAgentEffect(prepared.session, {
      disposition: "retryable",
      operationId: "op_continue",
    });
    expect(handlesOf(restored)).toEqual([
      { address, identity, lastStatus: "initial findings", phase: "parked" },
    ]);
  });

  it("deletes a running start even when the failure is retryable", () => {
    // A fresh start has no parked state to restore; the model retries by
    // starting a new agent instead.
    const session = rejectAgentEffect(runningSession(), {
      disposition: "retryable",
      operationId: startOperation.id,
    });
    expect(handlesOf(session)).toEqual([]);
  });

  it("ignores unknown operations", () => {
    const parked = parkedSession();
    expect(rejectAgentEffect(parked, { disposition: "dead", operationId: "op_gone" })).toBe(parked);
  });
});

describe("abandonRunningAgentTurns", () => {
  it("parks a running handle as cancelled so it stays resumable", () => {
    const abandoned = abandonRunningAgentTurns(runningSession());
    expect(handlesOf(abandoned)).toEqual([
      { address, identity, lastStatus: "(cancelled)", phase: "parked" },
    ]);
  });

  it("returns the session unchanged when nothing is running", () => {
    const parked = parkedSession();
    expect(abandonRunningAgentTurns(parked)).toBe(parked);

    const empty = createSession();
    expect(abandonRunningAgentTurns(empty)).toBe(empty);
  });
});

describe("owner-scoped handle claims", () => {
  it("keeps a recorded workflow run's claim separate from a task claim", () => {
    const available: TaskOwnedAgentHandle = { address, identity, phase: "available" };
    const workflowClaim = applyAgentHandleStoreCommand(
      { handles: [available] },
      {
        agentId: identity.id,
        callId: "call-workflow",
        expectedTarget: "local",
        invokedName: identity.name,
        kind: "claim",
        operationId: "operation-workflow",
        ownerId: "workflow-run-1",
      },
    );

    expect(workflowClaim.result).toMatchObject({
      handle: { ownerId: "workflow-run-1", phase: "claimed" },
      kind: "ready",
    });
    expect(
      applyAgentHandleStoreCommand(workflowClaim.store, {
        agentId: identity.id,
        callId: "call-task",
        expectedTarget: "local",
        invokedName: identity.name,
        kind: "claim",
        operationId: "operation-task",
        ownerId: "task_1",
      }).result,
    ).toMatchObject({ handle: { ownerId: "workflow-run-1" }, kind: "busy" });
  });
});

describe("settleAgentTurn", () => {
  it("parks the handle with a truncated status on a parked outcome", () => {
    const settled = settleAgentTurn(runningSession(), {
      operationId: startOperation.id,
      outcome: {
        kind: "parked",
        result: { kind: "succeeded", output: `  padded\n${"x".repeat(200)}  ` },
        usageDelta: ZERO_USAGE,
      },
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind !== "settled") {
      return;
    }
    const [handle] = handlesOf(settled.session);
    expect(handle?.phase).toBe("parked");
    if (handle?.phase === "parked") {
      expect(handle.lastStatus.length).toBeLessThanOrEqual(120);
      expect(handle.lastStatus.startsWith("padded x")).toBe(true);
    }
  });

  it("deletes the handle on a terminal outcome, including failures", () => {
    const settled = settleAgentTurn(runningSession(), {
      operationId: startOperation.id,
      outcome: {
        kind: "terminal",
        result: { error: { code: "BOOM" }, kind: "failed" },
        usageDelta: ZERO_USAGE,
      },
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") {
      expect(handlesOf(settled.session)).toEqual([]);
    }
  });

  it("keeps a failed-but-parked child resumable", () => {
    const settled = settleAgentTurn(runningSession(), {
      operationId: startOperation.id,
      outcome: {
        kind: "parked",
        result: { error: "model overloaded", kind: "failed" },
        usageDelta: ZERO_USAGE,
      },
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") {
      expect(handlesOf(settled.session)[0]?.phase).toBe("parked");
    }
  });

  it("ignores stale operations", () => {
    expect(
      settleAgentTurn(runningSession(), {
        operationId: "op_stale",
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output: "" },
          usageDelta: ZERO_USAGE,
        },
      }),
    ).toEqual({ kind: "ignored", reason: "unknown-operation" });
  });
});

describe("agent handle store task leases", () => {
  it("reserves and confirms a task-owned start, then releases it for another task", () => {
    const reserved = applyAgentHandleStoreCommand(EMPTY_AGENT_HANDLE_STORE, {
      identity,
      kind: "reserve",
      operationId: "operation-1",
      ownerId: "task-1",
    });
    expect(reserved.result).toMatchObject({ handle: { phase: "reserved" }, kind: "ready" });

    const confirmed = applyAgentHandleStoreCommand(reserved.store, {
      address,
      kind: "confirm",
      operationId: "operation-1",
      ownerId: "task-1",
    });
    expect(confirmed.result).toEqual({
      kind: "ready",
      handle: {
        address,
        identity,
        operationId: "operation-1",
        phase: "claimed",
        ownerId: "task-1",
      },
    });

    const released = applyAgentHandleStoreCommand(confirmed.store, {
      kind: "release-owner",
      ownerId: "task-1",
    });
    expect(released.store.handles).toEqual([{ address, identity, phase: "available" }]);
  });

  it("claims a parked child through the owner-scoped continuation path", () => {
    const parked: AgentHandle = { address, identity, lastStatus: "(cancelled)", phase: "parked" };
    const claimed = applyAgentHandleStoreCommand(
      { handles: [parked] },
      {
        agentId: identity.id,
        expectedTarget: "local",
        invokedName: identity.name,
        kind: "claim",
        operationId: "operation-2",
        ownerId: "workflow-run-2",
      },
    );

    expect(claimed.result).toMatchObject({
      handle: { ownerId: "workflow-run-2", phase: "claimed" },
      kind: "ready",
    });
  });

  it("parks claimed workflow owners as cancelled without changing available handles", () => {
    const claimed: AgentHandle = {
      address,
      identity,
      operationId: "operation-1",
      ownerId: "workflow-run-1",
      phase: "claimed",
    };
    const availableIdentity = { ...identity, id: "agent-2" };
    const session = writeHandles(createSession(), [
      claimed,
      { address, identity: availableIdentity, phase: "available" },
    ]);

    expect(handlesOf(abandonAgentInvocationOwners(session, new Set(["workflow-run-1"])))).toEqual([
      { address, identity, lastStatus: "(cancelled)", phase: "parked" },
      { address, identity: availableIdentity, phase: "available" },
    ]);
  });

  it("allows only one task to claim an available session agent", () => {
    const available: TaskOwnedAgentHandle = { address, identity, phase: "available" };
    const claimed = applyAgentHandleStoreCommand(
      { handles: [available] },
      {
        agentId: identity.id,
        expectedTarget: "local",
        invokedName: identity.name,
        kind: "claim",
        operationId: "operation-2",
        ownerId: "task-2",
      },
    );
    expect(claimed.result).toMatchObject({ handle: { phase: "claimed" }, kind: "ready" });

    const competing = applyAgentHandleStoreCommand(claimed.store, {
      agentId: identity.id,
      expectedTarget: "local",
      invokedName: identity.name,
      kind: "claim",
      operationId: "operation-3",
      ownerId: "task-3",
    });
    expect(competing.result).toMatchObject({ handle: { ownerId: "task-2" }, kind: "busy" });
    expect(competing.store).toBe(claimed.store);
  });

  it("rejects a name or target mismatch without changing the store", () => {
    const available: TaskOwnedAgentHandle = { address, identity, phase: "available" };

    for (const command of [
      { expectedTarget: "local" as const, invokedName: "writer" },
      { expectedTarget: "remote" as const, invokedName: identity.name },
    ]) {
      const result = applyAgentHandleStoreCommand(
        { handles: [available] },
        {
          agentId: identity.id,
          ...command,
          kind: "claim",
          operationId: "operation-2",
          ownerId: "task-2",
        },
      );
      expect(result.result).toMatchObject({ kind: "mismatch" });
      expect(result.store.handles).toEqual([available]);
    }
  });

  it("does not let one task remove another task's claimed agent", () => {
    const claimed: TaskOwnedAgentHandle = {
      address,
      identity,
      operationId: "operation-1",
      phase: "claimed",
      ownerId: "task-1",
    };
    const result = applyAgentHandleStoreCommand(
      { handles: [claimed] },
      { agentId: identity.id, kind: "remove", ownerId: "task-2" },
    );

    expect(result.result).toEqual({ handle: claimed, kind: "busy" });
    expect(result.store.handles).toEqual([claimed]);
  });
});
