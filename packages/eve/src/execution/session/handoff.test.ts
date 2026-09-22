import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionHandoff, type SessionOwnerActivation } from "#execution/session/handoff.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const isSessionIdleForHandoffStepMock = vi.fn(async (..._args: unknown[]) => true);
const startSessionOwnerStepMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#execution/session/handoff-steps.js", () => ({
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
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

const STABLE = "eve:session:session-1:inbox";

describe("SessionHandoff", () => {
  it("transfers one eligible conversational trigger with a structural checkpoint", async () => {
    const handoff = createHandoff(createInbox());
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const trigger = selection("deployment-b");

    await expect(handoff.tryTransfer(trigger, state())).resolves.toEqual({
      kind: "transferred",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith({
      activationToken: "owner-1:handoff",
      anchorRunId: "session-1",
      checkpoint: expect.objectContaining({
        mode: "conversation",
        sessionTimeoutMs: 60_000,
        version: 7,
      }),
      delivery: trigger.delivery,
      targetDeploymentId: "deployment-b",
    });
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
  });

  it.each([
    ["same-deployment", "deployment-a"],
    ["missing-deployment", "latest"],
  ] as const)("retains ownership for %s", async (reason, deployment) => {
    installActivation({ kind: "active" });
    const handoff = createHandoff(createInbox());
    await expect(handoff.tryTransfer(selection(deployment), state())).resolves.toEqual({
      kind: "retained",
      reason,
    });
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
  });

  it("retains ownership when the selection was not a lone fresh conversational delivery", async () => {
    installActivation({ kind: "active" });
    const inbox = createInbox();
    await expect(
      createHandoff(inbox).tryTransfer(
        { ...selection("deployment-b"), handoffEligible: false },
        state(),
      ),
    ).resolves.toEqual({ kind: "retained", reason: "busy" });
    expect(inbox.release).not.toHaveBeenCalled();
  });

  it("retains ownership when durable state still holds work", async () => {
    installActivation({ kind: "active" });
    isSessionIdleForHandoffStepMock.mockResolvedValue(false);
    const inbox = createInbox();
    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "not-idle" });
    expect(inbox.release).not.toHaveBeenCalled();
  });

  it("hands off alias-bearing sessions, marking every address while it is unowned", async () => {
    const inbox = createInbox();
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const aliased = state({
      continuationToken: "channel:current",
      serializedContext: { "eve.continuationHookTokens": ["channel:old", "channel:current"] },
    });

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), aliased),
    ).resolves.toEqual({
      kind: "transferred",
    });
    const markerTokens = createHookMock.mock.calls
      .map((call) => (call[0] as { token: string }).token)
      .filter((token) => token.startsWith("eve:inbox:handoff:"));
    expect(markerTokens).toEqual([
      `eve:inbox:handoff:${STABLE}`,
      "eve:inbox:handoff:channel:old",
      "eve:inbox:handoff:channel:current",
    ]);
    // Markers and the activation hook are released; the anchor stays for the parked original run.
    for (const hook of createdHooks().filter((hook) => !hook.token.endsWith(":anchor"))) {
      expect(hook.dispose).toHaveBeenCalled();
    }
  });

  it("keeps ownership and restores accepted payloads when activation fails", async () => {
    const inbox = createInbox();
    const payloads: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "Alice sends the first input." } },
      { kind: "send", payload: { message: "Bob sends the second input." } },
    ];
    installActivation({ error: new Error("bundle mismatch"), kind: "failed", payloads });
    startSessionOwnerStepMock.mockResolvedValue(undefined);

    await expect(
      createHandoff(inbox).tryTransfer(
        selection("deployment-b"),
        state({ continuationToken: "channel:current" }),
      ),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(inbox.claimSessionHooks).toHaveBeenCalledWith([STABLE, "channel:current"]);
    expect(inbox.restore).toHaveBeenCalledWith(payloads);
  });

  it("abandons transfer when input was accepted during release", async () => {
    installActivation({ kind: "active" });
    const accepted: SessionInboxPayload[] = [{ kind: "send", payload: { message: "late" } }];
    const inbox = createInbox({ released: accepted });

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "accepted-during-release" });
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    expect(inbox.restore).toHaveBeenCalledWith(accepted);
  });
});

const created: { token: string; dispose: ReturnType<typeof vi.fn> }[] = [];
function createdHooks() {
  return created;
}

function installActivation(activation: SessionOwnerActivation): void {
  created.length = 0;
  createHookMock.mockImplementation((options: { token: string }) => {
    const resolved = options.token.endsWith(":anchor") ? { output: "done" } : activation;
    const hook = Object.assign(Promise.resolve(resolved), {
      dispose: vi.fn(),
      getConflict: vi.fn(async () => null),
      token: options.token,
    });
    created.push(hook);
    return hook;
  });
}

function delivery(acceptedDeploymentId: string): DeliverHookPayload {
  return {
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
}

function selection(acceptedDeploymentId: string): TurnSelection {
  return {
    delivery: delivery(acceptedDeploymentId),
    handoffEligible: true,
    kind: "turn",
    sequences: [0],
  };
}

function state(
  input: {
    readonly continuationToken?: string;
    readonly serializedContext?: Record<string, unknown>;
  } = {},
) {
  return {
    serializedContext: input.serializedContext ?? {},
    sessionState: {
      continuationToken: input.continuationToken ?? "",
      sessionId: "session-1",
    } as DurableSessionState,
  };
}

function createHandoff(inbox: SessionInboxHandle): SessionHandoff {
  return new SessionHandoff({
    checkpoint: { mode: "conversation", sessionTimeoutMs: 60_000 },
    deploymentId: "deployment-a",
    inbox,
    isInitialOwner: true,
    sessionId: "session-1",
  });
}

function createInbox(input: { released?: SessionInboxPayload[] } = {}): SessionInboxHandle {
  return {
    claimSessionHook: vi.fn(async () => {}),
    claimSessionHooks: vi.fn(async () => {}),
    claimedTokens: [],
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => []),
    hasPending: vi.fn(() => false),
    next: vi.fn(),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => input.released ?? []),
    restore: vi.fn(),
  };
}
