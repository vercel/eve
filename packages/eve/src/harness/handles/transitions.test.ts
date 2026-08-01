import { describe, expect, it } from "vitest";

import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  deriveAgentId,
  getAgentHandleStore,
  type AgentAddress,
  type AgentHandle,
  type AgentIdentity,
  type ContinueOperation,
  type StartOperation,
} from "#harness/handles/store.js";
import {
  confirmAgentStarted,
  prepareAgentContinuation,
  prepareAgentStart,
  rejectAgentEffect,
  settleAgentTurn,
} from "#harness/handles/transitions.js";
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
    claim: { kind: "session", sessionId: address.sessionId },
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

describe("prepareAgentContinuation", () => {
  const continueOperation: ContinueOperation = {
    callId: "call_2",
    id: deriveAgentOperationId({
      callId: "call_2",
      parentSessionId: "session_parent",
      parentTurnId: "turn_2",
    }),
    kind: "continue",
    parentTurnId: "turn_2",
    previousStatus: "",
  };

  it("moves parked to running and captures the previous status", () => {
    const result = prepareAgentContinuation(parkedSession(), {
      agentId: identity.id,
      invokedName: "research",
      operation: continueOperation,
    });
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") {
      return;
    }
    expect(result.handle.phase).toBe("running");
    expect(result.handle.operation).toEqual({
      ...continueOperation,
      previousStatus: "initial findings",
    });
    expect(handlesOf(result.session)).toEqual([result.handle]);
  });

  it("reports unknown, mismatch, and busy without changing the session", () => {
    expect(
      prepareAgentContinuation(parkedSession(), {
        agentId: "ag_missing:000000000000",
        invokedName: "research",
        operation: continueOperation,
      }),
    ).toEqual({ kind: "unknown" });

    expect(
      prepareAgentContinuation(parkedSession(), {
        agentId: identity.id,
        invokedName: "writer",
        operation: continueOperation,
      }),
    ).toEqual({ kind: "mismatch" });

    expect(
      prepareAgentContinuation(runningSession(), {
        agentId: identity.id,
        invokedName: "research",
        operation: continueOperation,
      }),
    ).toEqual({ kind: "busy" });
  });

  it("treats the operation already recorded on a running handle as a replay", () => {
    const running = runningSession();
    const replay = prepareAgentContinuation(running, {
      agentId: identity.id,
      invokedName: "research",
      operation: {
        callId: startOperation.callId,
        id: startOperation.id,
        kind: "continue",
        parentTurnId: startOperation.parentTurnId,
        previousStatus: "",
      },
    });
    expect(replay.kind).toBe("ready");
    if (replay.kind === "ready") {
      expect(replay.session).toBe(running);
    }
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
    const continueOperation: ContinueOperation = {
      callId: "call_2",
      id: "op_continue",
      kind: "continue",
      parentTurnId: "turn_2",
      previousStatus: "",
    };
    const prepared = prepareAgentContinuation(parkedSession(), {
      agentId: identity.id,
      invokedName: "research",
      operation: continueOperation,
    });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready");
    }

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

describe("settleAgentTurn", () => {
  it("parks the handle with a truncated status on a parked outcome", () => {
    const settled = settleAgentTurn(runningSession(), {
      operationId: startOperation.id,
      outcome: {
        kind: "parked",
        result: { kind: "succeeded", output: `  padded\n${"x".repeat(200)}  ` },
        usageDelta: ZERO_USAGE,
      },
      claim: { kind: "session", sessionId: address.sessionId },
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
      claim: { kind: "session", sessionId: address.sessionId },
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") {
      expect(handlesOf(settled.session)).toEqual([]);
    }
  });

  it("settles a call-only claim from an older deployment on the operation alone", () => {
    const settled = settleAgentTurn(runningSession(), {
      claim: { kind: "call-only" },
      operationId: startOperation.id,
      outcome: {
        kind: "terminal",
        result: { kind: "succeeded", output: "done" },
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
      claim: { kind: "session", sessionId: address.sessionId },
    });
    expect(settled.kind).toBe("settled");
    if (settled.kind === "settled") {
      expect(handlesOf(settled.session)[0]?.phase).toBe("parked");
    }
  });

  it("ignores stale operations and mismatched child sessions", () => {
    expect(
      settleAgentTurn(runningSession(), {
        operationId: "op_stale",
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output: "" },
          usageDelta: ZERO_USAGE,
        },
        claim: { kind: "session", sessionId: address.sessionId },
      }),
    ).toEqual({ kind: "ignored", reason: "unknown-operation" });

    expect(
      settleAgentTurn(runningSession(), {
        operationId: startOperation.id,
        outcome: {
          kind: "parked",
          result: { kind: "succeeded", output: "" },
          usageDelta: ZERO_USAGE,
        },
        claim: { kind: "session", sessionId: "session_forged" },
      }),
    ).toEqual({ kind: "ignored", reason: "session-mismatch" });
  });
});
