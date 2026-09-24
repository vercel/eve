import { describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { bindDynamicConnections } from "#execution/dynamic-connections.js";
import { createApprovalCandidate } from "#harness/approval-candidates.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";

const alice = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const bob = { ...alice, principalId: "bob" };
const state = { sequence: 8, sessionStarted: true, stepIndex: 0, turnId: "" };
const runtime = { agentId: "test", eveVersion: "test" };
const origin = { sequence: 2, stepIndex: 1, turnId: "turn_2" };

function pendingSession(): HarnessSession {
  return appendPendingInputBatch({
    event: origin,
    requests: [
      {
        action: {
          kind: "tool-call",
          callId: "save",
          toolName: "notes__saveNote",
          input: { note: "hello" },
        },
        kind: "tool-approval",
        requestId: "approval",
        prompt: "Save this note?",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
      },
    ],
    responseAuthRequiredRequestIds: ["approval"],
    responseMessages: [],
    session: {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { threshold: 100_000, recentWindowSize: 10 },
      continuationToken: "test",
      history: [],
      sessionId: "test",
    },
  });
}

function setup() {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, bob);
  ctx.set(InitiatorAuthKey, alice);
  ctx.set(SessionIdKey, "test");
  const registry = new ConnectionRegistryImpl([]);
  ctx.set(ConnectionRegistryKey, registry);
  const turn = vi.fn(() => ({
    notes: defineMcpClientConnection({ description: "Notes", url: "https://notes.example/mcp" }),
  }));
  const session = vi.fn(() => null);
  const lifecycle = bindDynamicConnections(ctx, {
    dynamicConnectionResolvers: [
      {
        slug: "notes",
        sourceId: "notes",
        sourceKind: "module",
        logicalPath: "connections/notes.ts",
        eventNames: ["session.started", "turn.started"],
        events: { "session.started": session, "turn.started": turn },
      },
    ],
  });
  return { ctx, lifecycle, registry, session, turn };
}

describe("approval-only connection restoration", () => {
  it("uses the matching parked turn, not the upcoming turn, without changing auth or emission state", async () => {
    const fixture = setup();
    const before = structuredClone(state);
    await fixture.lifecycle.rehydrate(state, runtime, true, {
      session: pendingSession(),
      stepInput: { inputResponses: [{ requestId: "approval", optionId: "approve" }] },
    });
    expect(fixture.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.started",
        data: expect.objectContaining({ sequence: 2, turnId: "turn_2" }),
      }),
      expect.objectContaining({
        session: { id: "test", auth: { current: bob, initiator: alice } },
      }),
    );
    expect(fixture.registry.getConnectionNames()).toEqual(["notes"]);
    expect(fixture.ctx.get(AuthKey)).toEqual(bob);
    expect(state).toEqual(before);
  });

  it("restores on a candidate-only continuation with no new response", async () => {
    const fixture = setup();
    const pending = pendingSession();
    const candidate = createApprovalCandidate({
      candidateIdPrefix: "candidate",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      requestId: "approval",
      responder: bob,
      state: pending.state,
    });
    await fixture.lifecycle.rehydrate(state, runtime, true, {
      session: { ...pending, state: candidate.state },
    });
    expect(fixture.turn).toHaveBeenCalledOnce();
    expect(fixture.registry.getConnectionNames()).toEqual(["notes"]);
  });

  it.each<StepInput | undefined>([
    undefined,
    { message: "An ordinary new message" },
    { inputResponses: [{ requestId: "approval", optionId: "cancel" }] },
    { inputResponses: [{ requestId: "stale", optionId: "approve" }] },
    { message: "approve" },
  ])(
    "does not restore for unrelated input, cancellation, or text requiring responder auth: %j",
    async (stepInput) => {
      const fixture = setup();
      await fixture.lifecycle.rehydrate(state, runtime, true, {
        session: pendingSession(),
        stepInput,
      });
      expect(fixture.session).toHaveBeenCalledOnce();
      expect(fixture.turn).not.toHaveBeenCalled();
    },
  );

  it("keeps ordinary active-turn restoration unchanged", async () => {
    const fixture = setup();
    await fixture.lifecycle.rehydrate({ ...state, turnId: "turn_8" }, runtime, false, {
      session: pendingSession(),
    });
    expect(fixture.turn).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sequence: 8, turnId: "turn_8" }) }),
      expect.anything(),
    );
  });

  it("does not resolve any connections before session start", async () => {
    const fixture = setup();
    await fixture.lifecycle.rehydrate({ ...state, sessionStarted: false }, runtime, true);
    expect(fixture.session).not.toHaveBeenCalled();
    expect(fixture.turn).not.toHaveBeenCalled();
  });
});
