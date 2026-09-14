import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionHandoff, type SessionOwnerActivation } from "#execution/session-handoff.js";
import type { TurnSelection } from "#execution/session-input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const isSessionIdleForHandoffStepMock = vi.fn(async (..._args: unknown[]) => true);
const startSessionOwnerStepMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#execution/session-handoff-eligibility-step.js", () => ({
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  startSessionOwnerStep: (...args: unknown[]) => startSessionOwnerStepMock(...args),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
  isSessionIdleForHandoffStepMock.mockResolvedValue(true);
});

const HOOKS = {
  aliases: ["continuation-1", "continuation-2"],
  stable: "custom-stable",
} as const;

describe("SessionHandoff", () => {
  it("transfers one eligible conversational trigger with a structural checkpoint", async () => {
    const handoff = createHandoff(createInbox());
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const trigger = selection("deployment-b");

    await expect(handoff.tryTransfer(trigger, snapshot())).resolves.toEqual({
      kind: "transferred",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith({
      activationToken: "owner-1:handoff",
      checkpoint: expect.objectContaining({
        anchorToken: "session-1:anchor",
        hooks: HOOKS,
        ownership: {
          anchorRunId: "anchor-1",
          deploymentId: "deployment-a",
          ownerRunId: "owner-1",
          sessionId: "session-1",
        },
        version: 2,
      }),
      targetDeploymentId: "deployment-b",
      trigger: { delivery: trigger.delivery },
    });
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
  });

  it.each([
    ["same-deployment", "deployment-a", true],
    ["missing-deployment", "latest", true],
    ["busy", "deployment-b", false],
  ] as const)("retains ownership for %s", async (reason, deployment, eligible) => {
    const handoff = createHandoff(createInbox());
    await expect(handoff.tryTransfer(selection(deployment, eligible), snapshot())).resolves.toEqual(
      {
        kind: "retained",
        reason,
      },
    );
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
  });

  it("keeps ownership and restores accepted payloads when activation fails", async () => {
    const inbox = createInbox();
    const payloads: SessionInboxPayload[] = [{ kind: "clear" }];
    installActivation({ error: new Error("bundle mismatch"), kind: "failed", payloads });
    startSessionOwnerStepMock.mockResolvedValue(undefined);

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), snapshot()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(vi.mocked(inbox.claimSessionHook).mock.calls.map(([token]) => token)).toEqual([
      HOOKS.stable,
      ...HOOKS.aliases,
    ]);
    expect(inbox.restore).toHaveBeenCalledWith(payloads);
  });

  it("abandons transfer when input was accepted during release", async () => {
    const accepted: SessionInboxPayload[] = [{ kind: "send", payload: { message: "late" } }];
    const inbox = createInbox({ released: accepted });

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), snapshot()),
    ).resolves.toEqual({ kind: "retained", reason: "accepted-during-release" });
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    expect(inbox.restore).toHaveBeenCalledWith(accepted);
  });
});

function installActivation(activation: SessionOwnerActivation): void {
  createHookMock.mockImplementation((options: { token: string }) => {
    const resolved = options.token.endsWith(":anchor") ? { output: "done" } : activation;
    return Object.assign(Promise.resolve(resolved), {
      dispose: vi.fn(),
      getConflict: vi.fn(async () => null),
      token: options.token,
    });
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

function selection(acceptedDeploymentId: string, handoffEligible = true): TurnSelection {
  const selected = delivery(acceptedDeploymentId);
  return {
    delivery: selected,
    kind: "turn",
    provenance: {
      admissions: [{ delivery: selected, sequence: 0 }],
      handoffEligible,
      source: "conversation",
    },
  };
}

function snapshot() {
  return {
    serializedContext: {},
    sessionState: {
      continuationToken: "continuation-1",
      sessionId: "session-1",
    } as DurableSessionState,
  };
}

function createHandoff(commandInbox: SessionInboxHandle): SessionHandoff {
  return new SessionHandoff({
    anchorToken: "session-1:anchor",
    commandInbox,
    isInitialOwner: true,
    mode: "conversation",
    ownership: {
      anchorRunId: "anchor-1",
      deploymentId: "deployment-a",
      ownerRunId: "owner-1",
      sessionId: "session-1",
    },
  });
}

function createInbox(
  input: { pending?: boolean; released?: SessionInboxPayload[] } = {},
): SessionInboxHandle {
  return {
    claimSessionHook: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => []),
    hookClaims: HOOKS,
    hasPending: vi.fn(() => input.pending === true),
    hasReadyAuthorization: vi.fn(() => false),
    read: vi.fn(),
    release: vi.fn(async () => input.released ?? []),
    restore: vi.fn(),
    setAuthorizationWindow: vi.fn(),
  };
}
