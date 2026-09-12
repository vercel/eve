import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionBacklog } from "#execution/session-backlog.js";
import { SessionHandoff, type SessionOwnerActivation } from "#execution/session-handoff.js";
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

const HOOKS = ["custom-stable", "continuation-1", "continuation-2"];

describe("SessionHandoff", () => {
  it("stages only one idle conversational delivery for a different exact deployment", async () => {
    const handoff = createHandoff(createInbox());

    await expect(handoff.checkpoint(delivery("deployment-b"), snapshot())).resolves.toMatchObject({
      kind: "ready",
      targetDeploymentId: "deployment-b",
      checkpoint: {
        anchorToken: "session-1:anchor",
        hooks: { session: HOOKS },
        ownership: {
          anchorRunId: "anchor-1",
          deploymentId: "deployment-a",
          ownerRunId: "owner-1",
          sessionId: "session-1",
        },
        version: 1,
      },
    });
    await expect(handoff.checkpoint(delivery("deployment-a"), snapshot())).resolves.toEqual({
      kind: "skipped",
      reason: "same-deployment",
    });
    await expect(handoff.checkpoint(delivery("latest"), snapshot())).resolves.toEqual({
      kind: "skipped",
      reason: "missing-deployment",
    });
  });

  it("skips a delivery when another accepted command is pending or buffered", async () => {
    const pendingInbox = createHandoff(createInbox({ pending: true }));
    await expect(pendingInbox.checkpoint(delivery("deployment-b"), snapshot())).resolves.toEqual({
      kind: "skipped",
      reason: "busy",
    });

    const backlog = new SessionBacklog();
    backlog.deliveries.push(delivery("deployment-b"));
    const buffered = createHandoff(createInbox(), backlog);
    await expect(buffered.checkpoint(delivery("deployment-b"), snapshot())).resolves.toEqual({
      kind: "skipped",
      reason: "busy",
    });
    expect(isSessionIdleForHandoffStepMock).not.toHaveBeenCalled();
  });

  it("keeps ownership and restores accepted payloads when the candidate fails to activate", async () => {
    const inbox = createInbox();
    const handoff = createHandoff(inbox);
    const payloads: SessionInboxPayload[] = [{ kind: "clear" }];
    installActivation({ error: new Error("bundle mismatch"), kind: "failed", payloads });
    startSessionOwnerStepMock.mockResolvedValue({ runId: "owner-2" });

    await expect(handoff.transfer(delivery("deployment-b"), snapshot())).resolves.toBe(false);

    expect(inbox.release).toHaveBeenCalledOnce();
    expect(vi.mocked(inbox.claimSessionHook).mock.calls.map(([token]) => token)).toEqual(HOOKS);
    expect(inbox.restore).toHaveBeenCalledWith(payloads);
  });

  it("abandons the transfer when a command arrives during release", async () => {
    const accepted: SessionInboxPayload[] = [{ kind: "send", payload: { message: "late" } }];
    const inbox = createInbox({ released: accepted });
    const handoff = createHandoff(inbox);

    await expect(handoff.transfer(delivery("deployment-b"), snapshot())).resolves.toBe(false);
    expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    expect(inbox.restore).toHaveBeenCalledWith(accepted);
  });

  it("reports a transfer once the successor activates", async () => {
    const handoff = createHandoff(createInbox());
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue({ runId: "owner-2" });

    await expect(handoff.transfer(delivery("deployment-b"), snapshot())).resolves.toBe(true);
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        activationToken: "owner-1:handoff",
        targetDeploymentId: "deployment-b",
      }),
    );
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
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
    deliveryMetadata: [
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

function snapshot() {
  return {
    serializedContext: {},
    sessionState: {
      continuationToken: "continuation-1",
      sessionId: "session-1",
    } as DurableSessionState,
  };
}

function createHandoff(
  commandInbox: SessionInboxHandle,
  backlog = new SessionBacklog(),
): SessionHandoff {
  return new SessionHandoff({
    anchorToken: "session-1:anchor",
    backlog,
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
    consumeNext: vi.fn(),
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => []),
    hasPending: vi.fn(() => input.pending === true),
    hasReadyAuthorization: vi.fn(() => false),
    next: vi.fn(),
    release: vi.fn(async () => input.released ?? []),
    restore: vi.fn(),
    sessionHookTokens: HOOKS,
    setAuthorizationWindow: vi.fn(),
  };
}
