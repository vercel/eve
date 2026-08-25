import { describe, expect, it } from "vitest";

import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  getAgentHandleStore,
  type AgentAddress,
  type AgentHandle,
  type AgentIdentity,
  type ContinueOperation,
  type StartOperation,
} from "#harness/handles/store.js";
import {
  abandonRunningAgentTurns,
  confirmAgentStarted,
  confirmTaskAgentAddress,
  prepareAgentContinuation,
  prepareAgentStart,
  rebaseAgentHandles,
  recordTaskAgentAddress,
  rejectAgentEffect,
  removeTaskAgentAddress,
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
  execution: "blocking",
  id: deriveAgentId("research", startOperation.id),
  name: "research",
  nodeId: "node_research",
  targetKind: "local",
};

const backgroundIdentity: AgentIdentity = { ...identity, execution: "background" };

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

describe("task agent addresses", () => {
  it("confirms a persistent background address", () => {
    const addressed = confirmTaskAgentAddress(preparedSession(), {
      address,
      operationId: startOperation.id,
    });

    expect(handlesOf(addressed)).toEqual([
      { address, identity: backgroundIdentity, phase: "addressed" },
    ]);
  });

  it("removes only the addressed task agent", () => {
    const addressed = confirmTaskAgentAddress(preparedSession(), {
      address,
      operationId: startOperation.id,
    });

    expect(handlesOf(removeTaskAgentAddress(addressed, identity.id))).toEqual([]);
  });
});

describe("recordTaskAgentAddress", () => {
  it("appends an addressed handle from a delegated task's executor binding", () => {
    const recorded = recordTaskAgentAddress(createSession(), { address, identity });
    expect(handlesOf(recorded)).toEqual([
      { address, identity: backgroundIdentity, phase: "addressed" },
    ]);
  });

  it("is a replay no-op when the identical handle is already stored", () => {
    const recorded = recordTaskAgentAddress(createSession(), { address, identity });
    expect(recordTaskAgentAddress(recorded, { address, identity })).toBe(recorded);
  });

  it("throws when the id already exists with different content", () => {
    const recorded = recordTaskAgentAddress(createSession(), { address, identity });
    expect(() =>
      recordTaskAgentAddress(recorded, {
        address: { ...address, continuationToken: "continuation_divergent" },
        identity,
      }),
    ).toThrow(identity.id);
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

describe("rebaseAgentHandles", () => {
  const otherHandle: AgentHandle = {
    address: {
      continuationToken: "continuation_other",
      kind: "agent/local",
      sessionId: "session_other",
    },
    identity: {
      execution: "blocking",
      id: "ag_writer:aaaaaaaaaaaa",
      name: "writer",
      nodeId: "node_writer",
      targetKind: "local",
    },
    lastStatus: "",
    phase: "parked",
  };
  const continueOperation: ContinueOperation = {
    callId: "call_2",
    id: "op_continue",
    kind: "continue",
    parentTurnId: "turn_2",
    previousStatus: "",
  };

  function withHandles(handles: readonly AgentHandle[]): HarnessSession {
    return createSession({ [AGENT_HANDLES_STATE_KEY]: { handles } });
  }

  function inPlaceChange(): { base: HarnessSession; next: HarnessSession } {
    const base = parkedSession();
    const prepared = prepareAgentContinuation(base, {
      agentId: identity.id,
      invokedName: "research",
      operation: continueOperation,
    });
    if (prepared.kind !== "ready") {
      throw new Error("expected ready");
    }
    return { base, next: prepared.session };
  }

  it("appends a handle the dispatch added onto a diverged working session", () => {
    const next = preparedSession();
    const current = withHandles([otherHandle]);
    const rebased = rebaseAgentHandles(current, {
      base: createSession().state,
      next: next.state,
    });
    expect(handlesOf(rebased)).toEqual([otherHandle, ...handlesOf(next)]);
  });

  it("applies a removal the dispatch made", () => {
    const base = confirmTaskAgentAddress(preparedSession(), {
      address,
      operationId: startOperation.id,
    });
    const current = withHandles([...handlesOf(base), otherHandle]);
    const rebased = rebaseAgentHandles(current, {
      base: base.state,
      next: removeTaskAgentAddress(base, identity.id).state,
    });
    expect(handlesOf(rebased)).toEqual([otherHandle]);
  });

  it("applies an in-place change the dispatch made", () => {
    const { base, next } = inPlaceChange();
    const current = withHandles([...handlesOf(base), otherHandle]);
    const rebased = rebaseAgentHandles(current, { base: base.state, next: next.state });
    expect(handlesOf(rebased)).toEqual([...handlesOf(next), otherHandle]);
  });

  it("throws when the dispatch and another effect changed the same handle differently", () => {
    const { base, next } = inPlaceChange();
    const current = withHandles([{ address, identity, lastStatus: "diverged", phase: "parked" }]);
    expect(() => rebaseAgentHandles(current, { base: base.state, next: next.state })).toThrow(
      identity.id,
    );
  });

  it("throws when an added id already exists with different content", () => {
    const current = withHandles([
      {
        identity,
        operation: startOperation,
        phase: "starting",
        target: { continuationToken: "continuation_divergent", kind: "agent/local" },
      },
    ]);
    expect(() =>
      rebaseAgentHandles(current, {
        base: createSession().state,
        next: preparedSession().state,
      }),
    ).toThrow(identity.id);
  });

  it("returns the working session unchanged when it already contains the delta", () => {
    const { base, next } = inPlaceChange();
    const current = withHandles(handlesOf(next));
    expect(rebaseAgentHandles(current, { base: base.state, next: next.state })).toBe(current);
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
