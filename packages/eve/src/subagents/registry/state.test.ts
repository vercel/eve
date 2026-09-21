import { describe, expect, it } from "vitest";

import { deriveAgentOperationId } from "#subagents/registry/operation-id.js";
import {
  AGENT_REGISTRY_STATE_KEY,
  assertPersistableAgentRegistryState,
  deriveAgentId,
  formatAgentStatus,
  getAgentRegistryState,
  type AgentAddress,
  type AgentRegistryEntry,
  type AgentIdentity,
  type StartOperation,
} from "#subagents/registry/state.js";

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

const parkedHandle: AgentRegistryEntry = {
  address,
  identity,
  lastStatus: "initial findings",
  phase: "parked",
};

describe("deriveAgentOperationId / deriveAgentId", () => {
  it("is deterministic on parent-controlled inputs and independent of the child session", () => {
    const again = deriveAgentOperationId({
      callId: "call_1",
      parentSessionId: "session_parent",
      parentTurnId: "turn_1",
    });
    expect(again).toBe(startOperation.id);
    expect(deriveAgentId("research", again)).toBe(identity.id);
    expect(identity.id.startsWith("ag_research:")).toBe(true);
  });

  it("changes when any input changes", () => {
    const other = deriveAgentOperationId({
      callId: "call_2",
      parentSessionId: "session_parent",
      parentTurnId: "turn_1",
    });
    expect(other).not.toBe(startOperation.id);
  });
});

describe("getAgentRegistryState", () => {
  it("returns undefined only when no store has been written", () => {
    expect(getAgentRegistryState(undefined)).toBeUndefined();
    expect(getAgentRegistryState({})).toBeUndefined();
  });

  it("throws on a present but malformed store instead of treating it as absent", () => {
    for (const malformed of [
      null,
      { handles: "not-an-array" },
      { handles: [{ phase: "starting" }] },
      {
        handles: [
          {
            address,
            identity,
            lastStatus: "x".repeat(121),
            phase: "parked",
          },
        ],
      },
    ]) {
      expect(() => getAgentRegistryState({ [AGENT_REGISTRY_STATE_KEY]: malformed })).toThrow(
        AGENT_REGISTRY_STATE_KEY,
      );
    }
  });

  it("rejects duplicate handle ids", () => {
    expect(() =>
      getAgentRegistryState({
        [AGENT_REGISTRY_STATE_KEY]: { handles: [parkedHandle, parkedHandle] },
      }),
    ).toThrow("unique");
  });
});

describe("assertPersistableAgentRegistryState", () => {
  it("returns a valid store unchanged in shape", () => {
    expect(assertPersistableAgentRegistryState({ handles: [parkedHandle] })).toEqual({
      handles: [parkedHandle],
    });
  });

  it("preserves a remote child's creation-time credential resolver", () => {
    const remoteHandle: AgentRegistryEntry = {
      address: {
        callbackBaseUrl: "https://parent.example.com",
        credentialResolver: { resolverId: "dynamic-credentials-step" },
        kind: "agent/remote",
        sessionId: "remote-child",
        url: "https://remote.example.com",
      },
      identity,
      lastStatus: "waiting",
      phase: "parked",
    };

    expect(assertPersistableAgentRegistryState({ handles: [remoteHandle] })).toEqual({
      handles: [remoteHandle],
    });
  });

  it("refuses to persist a malformed store", () => {
    const corrupt = {
      handles: [{ ...parkedHandle, lastStatus: "x".repeat(121) }],
    };
    expect(() => assertPersistableAgentRegistryState(corrupt)).toThrow(
      "Refusing to persist a corrupt agent registry",
    );
  });
});

describe("formatAgentStatus", () => {
  it("collapses whitespace, truncates to 120, and stringifies objects", () => {
    expect(formatAgentStatus("  a\n\tb  ")).toBe("a b");
    expect(formatAgentStatus({ ok: true })).toBe('{"ok":true}');
    expect(formatAgentStatus("y".repeat(300)).length).toBe(120);
  });
});
