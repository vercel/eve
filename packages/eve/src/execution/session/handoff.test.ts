import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HandoffWorkflowEntryInput } from "#execution/session/entry-input.js";
import {
  SessionHandoff,
  takeOverSession,
  type SessionHandoffProtocol,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import { isLegacyHandoff } from "#execution/session/legacy-handoff.js";
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

const STABLE = "eve:session:session-1:inbox";

describe("SessionHandoff", () => {
  describe("eligibility", () => {
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
      expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    });

    it("retains ownership when durable state still holds work", async () => {
      installActivation({ kind: "active" });
      isSessionIdleForHandoffStepMock.mockResolvedValue(false);
      await expect(
        createHandoff(createInbox()).tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "retained", reason: "not-idle" });
      expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    });
  });

  describe("takeover", () => {
    it("transfers while still owning every hook, with no markers or release", async () => {
      const inbox = createInbox();
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockResolvedValue(undefined);
      const trigger = selection("deployment-b");

      await expect(
        createHandoff(inbox).tryTransfer(trigger, state({ continuationToken: "channel:current" })),
      ).resolves.toEqual({ kind: "transferred" });
      expect(startSessionOwnerStepMock).toHaveBeenCalledWith({
        activationToken: "owner-1:handoff",
        anchorRunId: "session-1",
        checkpoint: expect.objectContaining({
          mode: "conversation",
          sessionTimeoutMs: 60_000,
          version: 8,
        }),
        delivery: trigger.delivery,
        targetDeploymentId: "deployment-b",
      });
      expect(createdTokens()).toEqual(["session-1:anchor", "owner-1:handoff"]);
      expect(inbox.release).not.toHaveBeenCalled();
      expect(inbox.dispose).toHaveBeenCalledOnce();
      expect(forwardSessionInputStepMock).not.toHaveBeenCalled();
    });

    it("parks the original run on the anchor after transferring", async () => {
      const handoff = createHandoff(createInbox());
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockResolvedValue(undefined);

      await handoff.tryTransfer(selection("deployment-b"), state());
      await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
    });

    it("forwards input accepted before the takeover to the successor in order", async () => {
      const accepted = [send("Alice adds a detail."), send("Bob adds another.")];
      const inbox = createInbox({ disposed: accepted });
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockResolvedValue(undefined);

      await expect(
        createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "transferred" });
      expect(forwardSessionInputStepMock).toHaveBeenCalledWith({
        payloads: accepted,
        sessionId: "session-1",
      });
    });

    it("stays transferred when forwarding fails", async () => {
      const inbox = createInbox({ disposed: [send("Alice adds a detail.")] });
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockResolvedValue(undefined);
      forwardSessionInputStepMock.mockRejectedValue(new Error("successor unreachable"));

      await expect(
        createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "transferred" });
    });

    it("keeps a backlog instead of transferring it", async () => {
      const inbox = createInbox({ pending: true });
      installActivation({ kind: "active" });

      await expect(
        createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "retained", reason: "busy" });
      expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
    });

    it("re-takes only the hooks a failed candidate released and replays in acceptance order", async () => {
      const inbox = createInbox({ queued: [send("Alice writes before the takeover.")] });
      installActivation({
        error: new Error("bundle mismatch"),
        kind: "failed",
        payloads: [send("Bob writes after the takeover.")],
        releasedTokens: ["channel:current"],
      });
      startSessionOwnerStepMock.mockResolvedValue(undefined);

      await expect(
        createHandoff(inbox).tryTransfer(
          selection("deployment-b"),
          state({ continuationToken: "channel:current" }),
        ),
      ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
      expect(inbox.restore).toHaveBeenCalledWith([
        send("Alice writes before the takeover."),
        send("Bob writes after the takeover."),
      ]);
      expect(inbox.takeSessionHooks).toHaveBeenCalledWith(["channel:current"]);
      expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
    });

    it("keeps every hook when the candidate never took any", async () => {
      const inbox = createInbox();
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockRejectedValue(new Error("start failed"));

      await expect(
        createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
      expect(inbox.takeSessionHooks).toHaveBeenCalledWith([]);
      expect(inbox.dispose).not.toHaveBeenCalled();
    });
  });

  describe("release (legacy)", () => {
    it("marks every address while it is unowned", async () => {
      const inbox = createInbox();
      installActivation({ kind: "active" });
      startSessionOwnerStepMock.mockResolvedValue(undefined);
      const aliased = state({
        continuationToken: "channel:current",
        serializedContext: { "eve.continuationHookTokens": ["channel:old", "channel:current"] },
      });

      await expect(
        createHandoff(inbox, "release").tryTransfer(selection("deployment-b"), aliased),
      ).resolves.toEqual({ kind: "transferred" });
      expect(inbox.release).toHaveBeenCalledOnce();
      expect(createdTokens().filter((token) => token.startsWith("eve:inbox:handoff:"))).toEqual([
        `eve:inbox:handoff:${STABLE}`,
        "eve:inbox:handoff:channel:old",
        "eve:inbox:handoff:channel:current",
      ]);
      // Markers and the activation hook are released; the anchor stays for the parked original run.
      for (const hook of created.filter((hook) => !hook.token.endsWith(":anchor"))) {
        expect(hook.dispose).toHaveBeenCalled();
      }
    });

    it("reclaims every hook and restores accepted payloads when activation fails", async () => {
      const inbox = createInbox();
      const payloads = [send("Alice sends the first input."), send("Bob sends the second input.")];
      installActivation({ error: new Error("bundle mismatch"), kind: "failed", payloads });
      startSessionOwnerStepMock.mockResolvedValue(undefined);

      await expect(
        createHandoff(inbox, "release").tryTransfer(
          selection("deployment-b"),
          state({ continuationToken: "channel:current" }),
        ),
      ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
      expect(inbox.claimSessionHooks).toHaveBeenCalledWith([STABLE, "channel:current"]);
      expect(inbox.restore).toHaveBeenCalledWith(payloads);
    });

    it("abandons transfer when input was accepted during release", async () => {
      installActivation({ kind: "active" });
      const accepted = [send("late")];
      const inbox = createInbox({ released: accepted });

      await expect(
        createHandoff(inbox, "release").tryTransfer(selection("deployment-b"), state()),
      ).resolves.toEqual({ kind: "retained", reason: "accepted-during-release" });
      expect(startSessionOwnerStepMock).not.toHaveBeenCalled();
      expect(inbox.restore).toHaveBeenCalledWith(accepted);
    });
  });
});

describe("takeOverSession", () => {
  it("fences the attempt alongside validation, then force-claims every hook", async () => {
    const inbox = { takeSessionHooks: vi.fn(async () => {}) };
    installFence(null);

    await expect(takeOverSession(handoffInput(), inbox, [STABLE, "channel:current"])).resolves.toBe(
      true,
    );
    expect(createdTokens()).toEqual(["owner-1:handoff:delivery-deployment-b"]);
    expect(validateSessionCheckpointStepMock).toHaveBeenCalledOnce();
    expect(inbox.takeSessionHooks).toHaveBeenCalledWith([STABLE, "channel:current"]);
  });

  it("leaves the session to a duplicate start that already won the attempt", async () => {
    const inbox = { takeSessionHooks: vi.fn(async () => {}) };
    installFence({ runId: "wrun_duplicate" });

    await expect(takeOverSession(handoffInput(), inbox, [STABLE])).resolves.toBe(false);
    expect(inbox.takeSessionHooks).not.toHaveBeenCalled();
  });

  it("claims nothing when the checkpoint is rejected", async () => {
    const inbox = { takeSessionHooks: vi.fn(async () => {}) };
    installFence(null);
    validateSessionCheckpointStepMock.mockRejectedValue(new Error("unsupported checkpoint"));

    await expect(takeOverSession(handoffInput(), inbox, [STABLE])).rejects.toThrow(
      "unsupported checkpoint",
    );
    expect(inbox.takeSessionHooks).not.toHaveBeenCalled();
  });

  it("serves only sources that stamp a handoff version", () => {
    expect(isLegacyHandoff({})).toBe(true);
    expect(isLegacyHandoff({ handoffVersion: 2 })).toBe(false);
  });
});

const created: { token: string; dispose: ReturnType<typeof vi.fn> }[] = [];
function createdTokens(): string[] {
  return created.map(({ token }) => token);
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

function installFence(conflict: { readonly runId: string } | null): void {
  created.length = 0;
  createHookMock.mockImplementation((options: { token: string }) => {
    const hook = {
      dispose: vi.fn(),
      getConflict: vi.fn(async () => conflict),
      token: options.token,
    };
    created.push(hook);
    return hook;
  });
}

function send(message: string): SessionInboxPayload {
  return { kind: "send", payload: { message } };
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

function handoffInput(): HandoffWorkflowEntryInput {
  const { serializedContext, sessionState } = state();
  return {
    activationToken: "owner-1:handoff",
    checkpoint: {
      mode: "conversation",
      serializedContext,
      sessionState,
      sessionTimeoutMs: 60_000,
      version: 8,
    },
    delivery: delivery("deployment-b"),
    handoffVersion: 2,
    kind: "handoff",
    ownerDeploymentId: "deployment-b",
    sessionId: "session-1",
    sessionWritable: new WritableStream(),
  };
}

function createHandoff(
  inbox: SessionInboxHandle,
  protocol: SessionHandoffProtocol = "takeover",
): SessionHandoff {
  return new SessionHandoff({
    checkpoint: { mode: "conversation", sessionTimeoutMs: 60_000 },
    deploymentId: "deployment-a",
    inbox,
    isInitialOwner: true,
    protocol,
    sessionId: "session-1",
  });
}

function createInbox(
  input: {
    readonly disposed?: SessionInboxPayload[];
    readonly pending?: boolean;
    readonly queued?: SessionInboxPayload[];
    readonly released?: SessionInboxPayload[];
  } = {},
): SessionInboxHandle {
  return {
    claimSessionHook: vi.fn(async () => {}),
    claimSessionHooks: vi.fn(async () => {}),
    claimedTokens: [],
    dispose: vi.fn(async () => input.disposed ?? []),
    drain: vi.fn(() => input.queued ?? []),
    hasPending: vi.fn(() => input.pending ?? false),
    next: vi.fn(),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => input.released ?? []),
    restore: vi.fn(),
    takeSessionHooks: vi.fn(async () => {}),
  };
}
