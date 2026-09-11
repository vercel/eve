import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionHandoff } from "#execution/session-handoff.js";
import type {
  SessionCommandInboxHandle,
  SessionInboxPayload,
} from "#execution/session-command-inbox.js";

const claimHookOwnershipMock = vi.fn();
const disposeHookMock = vi.fn();
const isSessionIdleForHandoffStepMock = vi.fn();
const startSessionOwnerStepMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: ({ token }: { token: string }) =>
    Object.assign(Promise.resolve({ kind: "active" }), { token }),
}));
vi.mock("#execution/hook-ownership.js", () => ({
  claimHookOwnership: (...args: unknown[]) => claimHookOwnershipMock(...args),
  disposeHook: (...args: unknown[]) => disposeHookMock(...args),
}));
vi.mock("#execution/session-handoff-eligibility-step.js", () => ({
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  startSessionOwnerStep: (...args: unknown[]) => startSessionOwnerStepMock(...args),
}));

afterEach(() => vi.clearAllMocks());

describe("SessionHandoff", () => {
  it("stages only one idle conversational delivery for a different exact deployment", async () => {
    const inbox = createInbox();
    isSessionIdleForHandoffStepMock.mockResolvedValue(true);
    const handoff = createHandoff(inbox);

    await expect(handoff.checkpoint(delivery("deployment-b"))).resolves.toMatchObject({
      kind: "ready",
      targetDeploymentId: "deployment-b",
      checkpoint: {
        anchorToken: "session-1:anchor",
        hooks: {
          authorization: "custom-auth",
          session: ["custom-stable", "continuation-1", "continuation-2"],
        },
        ownership: {
          anchorRunId: "anchor-1",
          deploymentId: "deployment-a",
          ownerRunId: "owner-1",
          sessionId: "session-1",
        },
      },
    });
    await expect(handoff.checkpoint(delivery("deployment-a"))).resolves.toEqual({
      kind: "skipped",
      reason: "same-deployment",
    });
    await expect(handoff.checkpoint(delivery("latest"))).resolves.toEqual({
      kind: "skipped",
      reason: "missing-deployment",
    });
  });

  it("skips a delivery when another accepted command is pending", async () => {
    const inbox = createInbox({ pending: true });
    const handoff = createHandoff(inbox);
    await expect(handoff.checkpoint(delivery("deployment-b"))).resolves.toEqual({
      kind: "skipped",
      reason: "busy",
    });
    expect(isSessionIdleForHandoffStepMock).not.toHaveBeenCalled();
  });

  it("reclaims the exact hook set and restores accepted payloads after failed activation", async () => {
    const inbox = createInbox();
    const handoff = createHandoff(inbox);
    const payloads: SessionInboxPayload[] = [{ kind: "clear" }];

    await handoff.recover(payloads);

    expect(inbox.claimSessionHook).toHaveBeenNthCalledWith(1, "custom-stable");
    expect(inbox.claimSessionHook).toHaveBeenNthCalledWith(2, "continuation-1");
    expect(inbox.claimSessionHook).toHaveBeenNthCalledWith(3, "continuation-2");
    expect(inbox.claimAuthorization).toHaveBeenCalledWith("custom-auth");
    expect(inbox.restore).toHaveBeenCalledWith(payloads);
  });
});

function createHandoff(commandInbox: SessionCommandInboxHandle): SessionHandoff {
  return new SessionHandoff({
    anchorToken: "session-1:anchor",
    authorizationHookToken: "custom-auth",
    bufferedDeliveries: [],
    bufferedSessionControls: [],
    commandInbox,
    mode: "conversation",
    ownership: {
      anchorRunId: "anchor-1",
      deploymentId: "deployment-a",
      ownerRunId: "owner-1",
      sessionId: "session-1",
    },
    serializedContext: {},
    sessionState: {
      continuationToken: "continuation-1",
      sessionId: "session-1",
    } as DurableSessionState,
  });
}

function createInbox(input: { pending?: boolean } = {}): SessionCommandInboxHandle {
  return {
    claimAuthorization: vi.fn(),
    claimSessionHook: vi.fn(),
    consumeNext: vi.fn(),
    drain: vi.fn(() => []),
    dispose: vi.fn(),
    hasPending: vi.fn(async () => input.pending === true),
    hasReadyAuthorization: vi.fn(() => false),
    next: vi.fn(),
    nextWithSource: vi.fn(),
    release: vi.fn(async () => []),
    restore: vi.fn(),
    sessionHookTokens: ["custom-stable", "continuation-1", "continuation-2"],
    setAuthorizationWindow: vi.fn(),
  };
}

function delivery(acceptedDeploymentId: string): DeliverHookPayload {
  return {
    deliveryMetadata: [
      {
        acceptedDeploymentId,
        channelKind: "http",
        channelName: "http",
        deliveryId: "delivery-1",
        payloadIndex: 0,
      },
    ],
    kind: "deliver",
    payloads: [{ message: "hello" }],
  };
}
