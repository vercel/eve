import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { SessionOwnerActivation } from "#execution/session/handoff.js";
import { isLegacyHandoff } from "#execution/session/legacy-handoff.js";
import { TakeoverSessionHandoff, takeOverSession } from "#execution/session/takeover-handoff.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const isSessionIdleForHandoffStepMock = vi.fn(async (..._args: unknown[]) => true);
const validateSessionCheckpointStepMock = vi.fn(async (..._args: unknown[]) => {});
const forwardSessionInputStepMock = vi.fn(async (..._args: unknown[]) => {});
const startSessionOwnerStepMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#execution/session/handoff-steps.js", () => ({
  forwardSessionInputStep: (...args: unknown[]) => forwardSessionInputStepMock(...args),
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
  validateSessionCheckpointStep: (...args: unknown[]) => validateSessionCheckpointStepMock(...args),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  startSessionOwnerStep: (...args: unknown[]) => startSessionOwnerStepMock(...args),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
}));

afterEach(() => {
  vi.resetAllMocks();
  isSessionIdleForHandoffStepMock.mockResolvedValue(true);
});

describe("TakeoverSessionHandoff", () => {
  it.each([
    ["same-deployment", "deployment-a"],
    ["missing-deployment", "latest"],
  ] as const)("retains ownership for %s", async (reason, deployment) => {
    installActivation({ kind: "active" });
    await expect(
      createHandoff(createInbox()).tryTransfer(selection(deployment), state()),
    ).resolves.toEqual({ kind: "retained", reason });
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
  });

  it("retains ownership when the selection is not handoff-eligible", async () => {
    installActivation({ kind: "active" });
    await expect(
      createHandoff(createInbox()).tryTransfer(
        { ...selection("deployment-b"), handoffEligible: false },
        state(),
      ),
    ).resolves.toEqual({ kind: "retained", reason: "busy" });
  });

  it("retains ownership when durable state still holds work", async () => {
    installActivation({ kind: "active" });
    isSessionIdleForHandoffStepMock.mockResolvedValue(false);
    await expect(
      createHandoff(createInbox()).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "not-idle" });
  });

  it("keeps a backlog instead of transferring it", async () => {
    installActivation({ kind: "active" });
    const inbox = createInbox();
    vi.mocked(inbox.hasPending).mockReturnValue(true);
    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "busy" });
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
  });

  it("starts the successor while keeping every hook, then parks on the anchor", async () => {
    const inbox = createInbox();
    const handoff = createHandoff(inbox);
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const trigger = selection("deployment-b");

    await expect(handoff.tryTransfer(trigger, state())).resolves.toEqual({ kind: "transferred" });
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith({
      activationToken: "owner-1:handoff",
      anchorRunId: "session-1",
      checkpoint: expect.objectContaining({ mode: "conversation", version: 8 }),
      delivery: trigger.delivery,
      targetDeploymentId: "deployment-b",
    });
    expect(createHookMock.mock.calls.map(([options]) => options.token)).toEqual([
      "session-1:anchor",
      "owner-1:handoff",
    ]);
    expect(inbox.release).not.toHaveBeenCalled();
    expect(forwardSessionInputStepMock).not.toHaveBeenCalled();
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
  });

  it("forwards input accepted before the takeover in order", async () => {
    const accepted = [send("Alice adds a detail."), send("Bob adds another.")];
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);

    await createHandoff(createInbox(accepted)).tryTransfer(selection("deployment-b"), state());
    expect(forwardSessionInputStepMock).toHaveBeenCalledWith({
      payloads: accepted,
      sessionId: "session-1",
    });
  });

  it.each([
    ["the candidate fails", () => undefined],
    ["the start fails", () => startSessionOwnerStepMock.mockRejectedValue(new Error("down"))],
  ])("keeps the session untouched when %s", async (_case, arrange) => {
    const inbox = createInbox();
    installActivation({ error: new Error("bundle mismatch"), kind: "failed", payloads: [] });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    arrange();

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(inbox.drain).not.toHaveBeenCalled();
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
  });
});

describe("takeOverSession", () => {
  it("fences the attempt, validates, then force-claims every hook", async () => {
    const inbox = { claim: vi.fn() };
    const tokens = ["eve:session:session-1:inbox", "channel:current"];
    installFence(null);

    await expect(takeOverSession(handoffInput(), inbox, tokens)).resolves.toBe(true);
    expect(createHookMock).toHaveBeenCalledWith({
      experimental_minRetention: "1d",
      token: "owner-1:handoff:delivery-deployment-b",
    });
    expect(validateSessionCheckpointStepMock).toHaveBeenCalledOnce();
    expect(inbox.claim.mock.calls).toEqual(tokens.map((token) => [token]));
  });

  it("leaves the session to another start of the same attempt", async () => {
    const inbox = { claim: vi.fn() };
    installFence({ runId: "wrun_first_start" });

    await expect(takeOverSession(handoffInput(), inbox, ["token"])).resolves.toBe(false);
    expect(inbox.claim).not.toHaveBeenCalled();
  });

  it("claims nothing when the checkpoint is rejected", async () => {
    const inbox = { claim: vi.fn() };
    installFence(null);
    validateSessionCheckpointStepMock.mockRejectedValue(new Error("unsupported checkpoint"));

    await expect(takeOverSession(handoffInput(), inbox, ["token"])).rejects.toThrow(
      "unsupported checkpoint",
    );
    expect(inbox.claim).not.toHaveBeenCalled();
  });

  it("serves only sources that stamp a handoff version", () => {
    expect(isLegacyHandoff({})).toBe(true);
    expect(isLegacyHandoff({ handoffVersion: 2 })).toBe(false);
  });
});

function installActivation(activation: SessionOwnerActivation): void {
  createHookMock.mockImplementation((options: { token: string }) =>
    Object.assign(
      Promise.resolve(options.token.endsWith(":anchor") ? { output: "done" } : activation),
      { dispose: vi.fn(), getConflict: vi.fn(async () => null), token: options.token },
    ),
  );
}

function installFence(conflict: { readonly runId: string } | null): void {
  createHookMock.mockImplementation((options: { token: string }) => ({
    dispose: vi.fn(),
    getConflict: vi.fn(async () => conflict),
    token: options.token,
  }));
}

function send(message: string): SessionInboxPayload {
  return { kind: "send", payload: { message } };
}

function selection(acceptedDeploymentId: string): TurnSelection {
  const delivery: DeliverHookPayload = {
    deliveryMetadata:
      acceptedDeploymentId === "latest"
        ? undefined
        : [
            {
              acceptedDeploymentId,
              channelKind: "http",
              channelName: "http",
              deliveryId: `delivery-${acceptedDeploymentId}`,
              payloadIndex: 0,
            },
          ],
    kind: "deliver",
    payloads: [{ message: "hello" }],
  };
  return { delivery, handoffEligible: true, kind: "turn", sequences: [0] };
}

function state() {
  return {
    serializedContext: {},
    sessionState: { continuationToken: "", sessionId: "session-1" } as DurableSessionState,
  };
}

function handoffInput(): HandoffWorkflowEntryInput {
  return {
    activationToken: "owner-1:handoff",
    checkpoint: { ...state(), mode: "conversation", sessionTimeoutMs: 60_000, version: 8 },
    delivery: selection("deployment-b").delivery,
    handoffVersion: 2,
    kind: "handoff",
    ownerDeploymentId: "deployment-b",
    sessionId: "session-1",
    sessionWritable: new WritableStream(),
  };
}

function createHandoff(inbox: SessionInboxHandle): TakeoverSessionHandoff {
  return new TakeoverSessionHandoff({
    checkpoint: { mode: "conversation", sessionTimeoutMs: 60_000 },
    deploymentId: "deployment-a",
    inbox,
    isInitialOwner: true,
    sessionId: "session-1",
  });
}

function createInbox(accepted: SessionInboxPayload[] = []): SessionInboxHandle {
  return {
    claimSessionHook: vi.fn(async () => {}),
    claimSessionHooks: vi.fn(async () => {}),
    claimedTokens: [],
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => accepted),
    claim: vi.fn(),
    hasPending: vi.fn(() => false),
    next: vi.fn(),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => []),
    restore: vi.fn(),
  };
}
