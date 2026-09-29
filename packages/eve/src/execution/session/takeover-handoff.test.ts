import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import type { SessionOwnerActivation } from "#execution/session/handoff.js";
import { TakeoverSessionHandoff, takeOverSession } from "#execution/session/takeover-handoff.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const isSessionIdleForHandoffStepMock = vi.fn(async (..._args: unknown[]) => true);
const validateSessionCheckpointStepMock = vi.fn(async (..._args: unknown[]) => {});
const forwardSessionInputStepMock = vi.fn(async (..._args: unknown[]) => true);
const logSessionHandoffStepMock = vi.fn(async (..._args: unknown[]) => {});
const supportsSessionTakeoverStepMock = vi.fn(async () => true);
const startSessionOwnerStepMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#execution/session/handoff-steps.js", () => ({
  forwardSessionInputStep: (...args: unknown[]) => forwardSessionInputStepMock(...args),
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
  logSessionHandoffStep: (...args: unknown[]) => logSessionHandoffStepMock(...args),
  supportsSessionTakeoverStep: () => supportsSessionTakeoverStepMock(),
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
  forwardSessionInputStepMock.mockResolvedValue(true);
  supportsSessionTakeoverStepMock.mockResolvedValue(true);
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
    // Turns that never try to move stay free of extra steps.
    expect(logSessionHandoffStepMock).not.toHaveBeenCalled();
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
      checkpoint: expect.objectContaining({ version: 9 }),
      delivery: trigger.delivery,
      targetDeploymentId: "deployment-b",
    });
    expect(createHookMock.mock.calls.map(([options]) => options.token)).toEqual([
      "session-1:anchor",
      "owner-1:handoff",
    ]);
    expect(inbox.release).not.toHaveBeenCalled();
    expect(forwardSessionInputStepMock).not.toHaveBeenCalled();
    expect(logSessionHandoffStepMock).toHaveBeenCalledWith({
      fields: {
        deploymentId: "deployment-a",
        forwarded: 0,
        protocol: "takeover",
        sessionId: "session-1",
        targetDeploymentId: "deployment-b",
      },
      level: "info",
      message: "session handed off to another deployment",
    });
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
  });

  it("forwards input accepted before the takeover in order, one step per payload", async () => {
    const accepted = [send("Alice adds a detail."), send("Bob adds another.")];
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);

    await createHandoff(createInbox(accepted)).tryTransfer(selection("deployment-b"), state());
    expect(forwardSessionInputStepMock.mock.calls).toEqual(
      accepted.map((payload) => [{ payload, sessionId: "session-1" }]),
    );
  });

  it("reports input it cannot forward instead of failing the transferred session", async () => {
    const accepted = [send("Alice adds a detail."), send("Bob adds another.")];
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    forwardSessionInputStepMock.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      createHandoff(createInbox(accepted)).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "transferred" });
    expect(forwardSessionInputStepMock).toHaveBeenCalledTimes(1);
    expect(logSessionHandoffStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.objectContaining({ forwarded: 0, unforwarded: 2 }),
        level: "warn",
      }),
    );
  });

  it("takes back what a failed successor took and queues what it accepted", async () => {
    const inbox = createInbox();
    let takenTokens: string[] = [];
    Object.defineProperty(inbox, "takenTokens", { get: () => takenTokens });
    const accepted = [send("Alice writes while the successor boots.")];
    installActivation({
      error: new Error("activation failed"),
      kind: "failed",
      payloads: accepted,
    });
    // The successor took the stable hook before it failed.
    startSessionOwnerStepMock.mockImplementation(async () => {
      takenTokens = ["eve:session:session-1:inbox"];
    });

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(inbox.enqueue).toHaveBeenCalledWith(accepted);
    expect(inbox.claim).toHaveBeenCalledWith(["eve:session:session-1:inbox"]);
    expect(vi.mocked(inbox.enqueue).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(inbox.claim).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(inbox.allowTakeover).mock.calls).toEqual([[true], [false]]);
    expect(forwardSessionInputStepMock).not.toHaveBeenCalled();
    expect(logSessionHandoffStepMock).toHaveBeenCalledWith({
      fields: expect.objectContaining({
        error: expect.objectContaining({ message: "activation failed" }),
        protocol: "takeover",
        reason: "activation-failed",
      }),
      level: "warn",
      message: "session handoff failed; the current owner kept the session",
    });
  });

  it("holds the attempt fence itself when the successor start fails", async () => {
    const inbox = createInbox();
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockRejectedValue(new Error("start timed out"));

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    const fence = createHookMock.mock.results.find(
      ({ value }) => value.token === "owner-1:handoff:delivery-deployment-b",
    )?.value as { dispose: ReturnType<typeof vi.fn> };
    expect(createHookMock).toHaveBeenCalledWith({
      experimental_minRetention: "1d",
      token: "owner-1:handoff:delivery-deployment-b",
    });
    // Released, the fence would let a successor the start created anyway take the session.
    expect(fence.dispose).not.toHaveBeenCalled();
    expect(inbox.claim).not.toHaveBeenCalled();
  });

  it("waits for a successor that already holds the fence when its start fails", async () => {
    installActivation({ kind: "active" }, { fenceHolder: "wrun_successor" });
    startSessionOwnerStepMock.mockRejectedValue(new Error("start timed out"));

    await expect(
      createHandoff(createInbox()).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "transferred" });
  });

  it("hands off release-first on a World without takeover support", async () => {
    const inbox = createInbox();
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    supportsSessionTakeoverStepMock.mockResolvedValue(false);

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "transferred" });
    expect(inbox.release).toHaveBeenCalled();
    expect(inbox.allowTakeover).not.toHaveBeenCalled();
    expect(logSessionHandoffStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.objectContaining({ protocol: "release" }),
        level: "info",
      }),
    );
  });
});

describe("takeOverSession", () => {
  it("fences the attempt, validates, reads the fence, then force-claims every hook", async () => {
    const inbox = { claim: vi.fn(async () => {}) };
    const tokens = ["eve:session:session-1:inbox", "channel:current"];
    installFence(null);

    await expect(takeOverSession(handoffInput(), inbox, tokens)).resolves.toBe(true);
    expect(createHookMock).toHaveBeenCalledWith({
      experimental_minRetention: "1d",
      token: "owner-1:handoff:delivery-deployment-b",
    });
    expect(inbox.claim).toHaveBeenCalledWith(tokens);
    // Reading the fence only after validation keeps validation inline.
    const fence = createHookMock.mock.results[0]?.value as {
      getConflict: ReturnType<typeof vi.fn>;
    };
    const order = [
      createHookMock.mock.invocationCallOrder[0],
      validateSessionCheckpointStepMock.mock.invocationCallOrder[0],
      fence.getConflict.mock.invocationCallOrder[0],
      inbox.claim.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });

  it("claims nothing when the trigger carries no delivery id", async () => {
    const inbox = { claim: vi.fn(async () => {}) };
    installFence(null);
    const input = handoffInput();

    await expect(
      takeOverSession(
        { ...input, delivery: { ...input.delivery, deliveryMetadata: undefined } },
        inbox,
        ["token"],
      ),
    ).rejects.toThrow("delivery id");
    expect(createHookMock).not.toHaveBeenCalled();
    expect(inbox.claim).not.toHaveBeenCalled();
  });

  it("leaves the session to another start of the same attempt", async () => {
    const inbox = { claim: vi.fn(async () => {}) };
    installFence({ runId: "wrun_first_start" });

    await expect(takeOverSession(handoffInput(), inbox, ["token"])).resolves.toBe(false);
    expect(inbox.claim).not.toHaveBeenCalled();
  });

  it("claims nothing when the checkpoint is rejected", async () => {
    const inbox = { claim: vi.fn(async () => {}) };
    installFence(null);
    validateSessionCheckpointStepMock.mockRejectedValue(new Error("unsupported checkpoint"));

    await expect(takeOverSession(handoffInput(), inbox, ["token"])).rejects.toThrow(
      "unsupported checkpoint",
    );
    expect(inbox.claim).not.toHaveBeenCalled();
  });
});

function installActivation(
  activation: SessionOwnerActivation,
  options: { readonly fenceHolder?: string } = {},
): void {
  createHookMock.mockImplementation((hook: { token: string }) => {
    const fence = hook.token.startsWith("owner-1:handoff:");
    const conflict = fence && options.fenceHolder ? { runId: options.fenceHolder } : null;
    return Object.assign(
      Promise.resolve(hook.token.endsWith(":anchor") ? { output: "done" } : activation),
      { dispose: vi.fn(), getConflict: vi.fn(async () => conflict), token: hook.token },
    );
  });
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
    checkpoint: { ...state(), sessionTimeoutMs: 60_000, version: 9 },
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
    checkpoint: { sessionTimeoutMs: 60_000 },
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
    allowTakeover: vi.fn(),
    claim: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => accepted),
    enqueue: vi.fn(),
    hasPending: vi.fn(() => false),
    next: vi.fn(),
    onAgentStarted: vi.fn(() => () => {}),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => []),
    restore: vi.fn(),
    takenTokens: [],
    whenPending: vi.fn(() => new Promise<void>(() => {})),
  };
}
