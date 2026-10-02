import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { SessionHandoff, type SessionOwnerActivation } from "#execution/session/handoff.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const isSessionIdleForHandoffStepMock = vi.fn(async (..._args: unknown[]) => true);
const reportSessionHandoffRetainedStepMock = vi.fn();
const startSessionOwnerStepMock = vi.fn();
const createHookMock = vi.fn();

vi.mock("#execution/session/handoff-steps.js", () => ({
  isSessionIdleForHandoffStep: (...args: unknown[]) => isSessionIdleForHandoffStepMock(...args),
  reportSessionHandoffRetainedStep: (...args: unknown[]) =>
    reportSessionHandoffRetainedStepMock(...args),
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
    const history = [
      { content: "Alice asks for the status.", kind: "user" as const, role: "user" as const },
    ];

    await expect(handoff.tryTransfer(trigger, { ...state(), history })).resolves.toEqual({
      kind: "transferred",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith({
      activationToken: "owner-1:handoff",
      anchorRunId: "session-1",
      checkpoint: expect.objectContaining({
        history,
        sessionTimeoutMs: 60_000,
        version: 11,
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

  it("moves a compacted session to this deployment with the delivery that arrived first", async () => {
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const sessionTimeoutDeadline = new Date("2026-11-01T00:00:00.000Z");
    const trigger = selection("deployment-a");

    await expect(
      createHandoff(createInbox()).tryTransfer(trigger, state(), {
        compaction: { sessionTimeoutDeadline },
      }),
    ).resolves.toEqual({ kind: "transferred" });
    expect(startSessionOwnerStepMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery: trigger.delivery,
        reason: "compaction",
        sessionTimeoutDeadline,
        targetDeploymentId: "deployment-a",
      }),
    );
  });

  it("moves a compacted session to a newer deployment as a deployment handoff", async () => {
    installActivation({ kind: "active" });
    startSessionOwnerStepMock.mockResolvedValue(undefined);

    await expect(
      createHandoff(createInbox()).tryTransfer(selection("deployment-b"), state(), {
        compaction: { sessionTimeoutDeadline: new Date("2026-11-01T00:00:00.000Z") },
      }),
    ).resolves.toEqual({ kind: "transferred" });
    const [start] = startSessionOwnerStepMock.mock.calls[0] as [Record<string, unknown>];
    expect(start).toMatchObject({ targetDeploymentId: "deployment-b" });
    expect(start).not.toHaveProperty("reason");
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

  it("remembers every incompatible target for the rest of the owner run", async () => {
    const inbox = createInbox();
    const payloads: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "Alice sends a follow-up." } },
    ];
    installActivationSequence(
      { kind: "incompatible", payloads, reason: "checkpoint-version" },
      { kind: "incompatible", payloads, reason: "checkpoint-version" },
    );
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const handoff = createHandoff(inbox);

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "checkpoint-incompatible",
    });
    expect(inbox.restore).toHaveBeenCalledWith(payloads);

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "known-incompatible",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledTimes(1);
    expect(inbox.release).toHaveBeenCalledTimes(1);

    await expect(handoff.tryTransfer(selection("deployment-c"), state())).resolves.toEqual({
      kind: "retained",
      reason: "checkpoint-incompatible",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledTimes(2);

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "known-incompatible",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledTimes(2);
    // Each refusing deployment is reported once; remembered skips stay quiet.
    expect(reportSessionHandoffRetainedStepMock.mock.calls).toEqual(
      ["deployment-b", "deployment-c"].map((targetDeploymentId) => [
        {
          error: undefined,
          reason: "checkpoint-incompatible",
          sessionId: "session-1",
          sourceDeploymentId: "deployment-a",
          targetDeploymentId,
        },
      ]),
    );
  });

  it("attempts handoff on every turn when the owner only sees a generic activation failure", async () => {
    installActivation({ error: new Error("unsupported checkpoint"), kind: "failed", payloads: [] });
    startSessionOwnerStepMock.mockResolvedValue(undefined);
    const handoff = createHandoff(createInbox());

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "activation-failed",
    });
    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "activation-failed",
    });
    expect(startSessionOwnerStepMock).toHaveBeenCalledTimes(2);
    expect(reportSessionHandoffRetainedStepMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: "unsupported checkpoint", reason: "activation-failed" }),
    );
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
  installActivationSequence(activation);
}

function installActivationSequence(...activations: SessionOwnerActivation[]): void {
  created.length = 0;
  let index = 0;
  createHookMock.mockImplementation((options: { token: string }) => {
    const resolved = options.token.endsWith(":anchor")
      ? { output: "done" }
      : (activations[Math.min(index++, activations.length - 1)] ?? activations.at(-1)!);
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
    history: [],
    serializedContext: input.serializedContext ?? {},
    sessionState: {
      continuationToken: input.continuationToken ?? "",
      sessionId: "session-1",
    } as DurableSessionState,
  };
}

function createHandoff(inbox: SessionInboxHandle): SessionHandoff {
  return new SessionHandoff({
    checkpoint: { sessionTimeoutMs: 60_000 },
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
    whenPending: () => new Promise<void>(() => {}),
    next: vi.fn(),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => input.released ?? []),
    restore: vi.fn(),
  };
}
