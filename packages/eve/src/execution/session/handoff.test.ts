import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeliverHookPayload } from "#channel/types.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import {
  SESSION_CHECKPOINT_VERSION,
  SessionHandoff,
  type SessionOwnerActivation,
} from "#execution/session/handoff.js";
import type { TurnSelection } from "#execution/session/input-queue.js";
import type { SessionInboxHandle, SessionInboxPayload } from "#execution/session-inbox/inbox.js";

const reportSessionHandoffRetainedStepMock = vi.fn();
const sendSessionHandoverPartStepMock = vi.fn();
const reportHandoverPartStuckStepMock = vi.fn();
const startSuccessorStepMock = vi.fn();
const createHookMock = vi.fn();
const sleepMock = vi.fn();

const abandonHandoverIfRunEndsMock = vi.fn();
/** Resolving it ends the watched candidate run. */
let candidateEnded = Promise.withResolvers<void>();
/** Resolvers for the inbox's pending arrival waits; resolving one delivers a payload. */
const arrivals: (() => void)[] = [];
/** The workflow clock, in milliseconds since the attempt began. */
let now = 0;
const watchedRuns: string[] = [];
const endedRuns = new Set<string>();

vi.mock("#execution/session/handoff-steps.js", () => ({
  hasRunEndedStep: async (input: { runId: string }) => endedRuns.has(input.runId),
  reportHandoverPartStuckStep: (...args: unknown[]) => reportHandoverPartStuckStepMock(...args),
  reportSessionHandoffRetainedStep: (...args: unknown[]) =>
    reportSessionHandoffRetainedStepMock(...args),
  sendSessionHandoverPartStep: (...args: unknown[]) => sendSessionHandoverPartStepMock(...args),
  startSuccessorStep: (...args: unknown[]) => startSuccessorStepMock(...args),
}));
vi.mock("#execution/session/run-watch.js", () => ({
  abandonHandoverIfRunEnds: (...args: unknown[]) => abandonHandoverIfRunEndsMock(...args),
  watchRunEnd: (runId: string) => {
    watchedRuns.push(runId);
    return { ended: candidateEnded.promise, stop: () => {} };
  },
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
  getWorkflowMetadata: () => ({ workflowRunId: "owner-1" }),
  sleep: (...args: unknown[]) => sleepMock(...args),
}));

beforeEach(() => {
  sendSessionHandoverPartStepMock.mockResolvedValue("delivered");
  sleepMock.mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.resetAllMocks();
  candidateEnded = Promise.withResolvers<void>();
  arrivals.length = 0;
  now = 0;
  vi.restoreAllMocks();
  watchedRuns.length = 0;
  endedRuns.clear();
});

const STARTED = { kind: "started", runId: "candidate-1" } as const;

const TOKENS = ["eve:session:session-1:inbox", "channel:current"];

describe("SessionHandoff", () => {
  it("hands over what it accepted once the successor takes over every hook", async () => {
    const accepted: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "Bob writes during the move." } },
    ];
    const inbox = createInbox({ takenOver: true, unread: accepted });
    const handoff = createHandoff(inbox);
    installActivation();
    startSuccessorStepMock.mockResolvedValue(STARTED);
    const trigger = selection("deployment-b");
    const history = [
      { content: "Alice asks for the status.", kind: "user" as const, role: "user" as const },
    ];

    await expect(handoff.tryTransfer(trigger, { ...state(), history })).resolves.toEqual({
      kind: "transferred",
    });
    expect(startSuccessorStepMock).toHaveBeenCalledWith({
      activationToken: "owner-1:handoff:0",
      anchorRunId: "session-1",
      attemptKey: "owner-1:0",
      checkpoint: expect.objectContaining({
        history,
        sessionTimeoutMs: 60_000,
        version: SESSION_CHECKPOINT_VERSION,
      }),
      delivery: trigger.delivery,
      hookTokens: TOKENS,
      sourceRunId: "owner-1",
      targetDeploymentId: "deployment-b",
    });
    expect(sendSessionHandoverPartStepMock.mock.calls.map(([call]) => call)).toEqual([
      { part: { attemptKey: "owner-1:0", index: 0, payloads: accepted }, sessionId: "session-1" },
      {
        part: { attemptKey: "owner-1:0", final: true, index: 1, payloads: [] },
        sessionId: "session-1",
      },
    ]);
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
    await expect(handoff.awaitAnchoredResult()).resolves.toEqual({ output: "done" });
  });

  it.each([
    ["same-deployment", "deployment-a"],
    ["missing-deployment", "latest"],
  ] as const)("retains ownership for %s", async (reason, deployment) => {
    installActivation();
    const handoff = createHandoff(createInbox());
    await expect(handoff.tryTransfer(selection(deployment), state())).resolves.toEqual({
      kind: "retained",
      reason,
    });
    expect(startSuccessorStepMock).not.toHaveBeenCalled();
  });

  it("moves a compacted session to a parked successor on this deployment", async () => {
    installActivation();
    startSuccessorStepMock.mockResolvedValue(STARTED);

    await expect(
      createHandoff(createInbox({ takenOver: true })).tryCompactionTransfer(state()),
    ).resolves.toEqual({ kind: "transferred" });
    const [start] = startSuccessorStepMock.mock.calls[0] as [Record<string, unknown>];
    expect(start).toMatchObject({
      reason: "compaction",
      targetDeploymentId: "deployment-a",
    });
    expect(start).not.toHaveProperty("delivery");
  });

  it.each([
    ["the selection was not a lone fresh delivery", { handoffEligible: false }, {}],
    ["a previous attempt's handover has not arrived", {}, { awaitingHandover: true }],
  ] as const)("stays busy when %s", async (_name, selected, inboxState) => {
    installActivation();
    await expect(
      createHandoff(createInbox(inboxState)).tryTransfer(
        { ...selection("deployment-b"), ...selected },
        state(),
      ),
    ).resolves.toEqual({ kind: "retained", reason: "busy" });
    expect(startSuccessorStepMock).not.toHaveBeenCalled();
  });

  it("retains ownership when durable state still holds work", async () => {
    const inbox = createInbox();
    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), {
        ...state(),
        sessionState: createTestSessionState(
          { sessionId: "session-1" },
          { sequence: 0, turnId: "turn_0" },
        ),
      }),
    ).resolves.toEqual({ kind: "retained", reason: "not-idle" });
    expect(startSuccessorStepMock).not.toHaveBeenCalled();
  });

  it("retains ownership without a handover when the start step finds work", async () => {
    installActivation();
    startSuccessorStepMock.mockResolvedValue({ kind: "not-idle" });
    const inbox = createInbox();
    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "not-idle" });
    expect(sendSessionHandoverPartStepMock).not.toHaveBeenCalled();
    expect(created.find((hook) => hook.token === "owner-1:handoff:0")?.dispose).toHaveBeenCalled();
  });

  it("still hands over once the successor took over when the start step failed after creating it", async () => {
    const inbox = createInbox({ takenOver: true });
    installActivation();
    leaseHolder = "candidate-1";
    startSuccessorStepMock.mockRejectedValue(new Error("start response lost"));

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "transferred" });
    expect(sendSessionHandoverPartStepMock).toHaveBeenCalledOnce();
  });

  it("retains the session when it wins the lease of an attempt whose start step failed", async () => {
    const inbox = createInbox({ takenOver: true });
    installActivation();
    startSuccessorStepMock.mockRejectedValue(new Error("deployment unreachable"));

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(created.map((hook) => hook.token)).toContain("eve:handoff:lease:owner-1:0");
    expect(sendSessionHandoverPartStepMock).not.toHaveBeenCalled();
  });

  it("fences at the deadline once one early message waits, and watches a live lease holder", async () => {
    let pending = false;
    const inbox = createInbox({ hasPending: () => pending });
    const deadline = Promise.withResolvers<void>();
    sleepMock.mockReturnValueOnce(deadline.promise);
    installActivation();
    leaseHolder = "candidate-1";
    startSuccessorStepMock.mockResolvedValue(STARTED);
    const outcome = createHandoff(inbox).tryTransfer(selection("deployment-b"), state());

    // Nothing waits, so no timer runs.
    await vi.waitFor(() => expect(arrivals).toHaveLength(1));
    expect(sleepMock).not.toHaveBeenCalled();
    now = 60_000;
    pending = true;
    arrivals.shift()!();
    await vi.waitFor(() => expect(sleepMock).toHaveBeenCalledWith(4 * 60_000));
    expect(created.map((hook) => hook.token)).not.toContain("eve:handoff:lease:owner-1:0");

    // No further input arrives; the deadline alone fences the attempt.
    deadline.resolve();
    await vi.waitFor(() => expect(watchedRuns).toEqual(["candidate-1"]));
    expect(reportSessionHandoffRetainedStepMock).not.toHaveBeenCalled();
    endedRuns.add("candidate-1");
    candidateEnded.resolve();

    await expect(outcome).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    // It may hold addresses this run's pumps have not seen it take yet.
    expect(inbox.claimSessionHooks).toHaveBeenCalledWith(TOKENS, { force: true });
  });

  it("counts input accepted during the start step and wins the lease from a candidate that never boots", async () => {
    const inbox = createInbox({ hasPending: () => true });
    installActivation();
    startSuccessorStepMock.mockImplementation(async () => {
      now = 30_000;
      return STARTED;
    });

    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(sleepMock).toHaveBeenCalledWith(5 * 60_000 - 30_000);
    const lease = created.find((hook) => hook.token === "eve:handoff:lease:owner-1:0");
    // Disposing it would free the token for a candidate that boots late.
    expect(lease?.dispose).not.toHaveBeenCalled();
    expect(watchedRuns).toEqual([]);
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
  });

  it("keeps waiting for the lease winner when a duplicate candidate reports a failure", async () => {
    const takeover = Promise.withResolvers<void>();
    const inbox = createInbox({ whenTakenOver: takeover.promise });
    installActivation({
      error: new Error("lost the race to prepare"),
      kind: "failed",
      payloads: [],
      runId: "candidate-2",
    });
    // The start step ran twice: it returned the duplicate, and the first run holds the lease.
    leaseHolder = "candidate-1";
    startSuccessorStepMock.mockResolvedValue({ kind: "started", runId: "candidate-2" });
    const outcome = createHandoff(inbox).tryTransfer(selection("deployment-b"), state());

    await vi.waitFor(() => expect(watchedRuns).toEqual(["candidate-1"]));
    expect(reportSessionHandoffRetainedStepMock).not.toHaveBeenCalled();
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
    expect(sleepMock).not.toHaveBeenCalled();
    takeover.resolve();

    await expect(outcome).resolves.toEqual({ kind: "transferred" });
  });

  it("retains on the verdict of the candidate that holds the lease", async () => {
    installActivation({
      error: new Error("could not read state"),
      kind: "failed",
      payloads: [],
      runId: "candidate-1",
    });
    leaseHolder = "candidate-1";
    startSuccessorStepMock.mockResolvedValue(STARTED);

    const inbox = createInbox();
    await expect(
      createHandoff(inbox).tryTransfer(selection("deployment-b"), state()),
    ).resolves.toEqual({ kind: "retained", reason: "activation-failed" });
    expect(watchedRuns).toEqual([]);
    // It reported holding no address.
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
  });

  it("retries every handover part until it is delivered, in order", async () => {
    const accepted: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "Bob's first note." } },
      { kind: "send", payload: { message: "Bob's second note." } },
    ];
    installActivation();
    startSuccessorStepMock.mockResolvedValue(STARTED);
    sendSessionHandoverPartStepMock
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockResolvedValueOnce("delivered")
      .mockResolvedValueOnce("delivered")
      .mockRejectedValueOnce(new Error("store unavailable"))
      .mockResolvedValueOnce("delivered");

    await expect(
      createHandoff(createInbox({ takenOver: true, unread: accepted })).tryTransfer(
        selection("deployment-b"),
        state(),
      ),
    ).resolves.toEqual({ kind: "transferred" });
    expect(sendSessionHandoverPartStepMock.mock.calls.map(([call]) => call.part.index)).toEqual([
      0, 0, 0, 1, 2, 2,
    ]);
    expect(sleepMock.mock.calls).toEqual([[1000], [2000], [1000]]);
  });

  it("reports a part that keeps failing once, and keeps retrying it", async () => {
    installActivation();
    startSuccessorStepMock.mockResolvedValue(STARTED);
    reportHandoverPartStuckStepMock.mockResolvedValue(undefined);
    for (let failure = 0; failure < 6; failure++)
      sendSessionHandoverPartStepMock.mockRejectedValueOnce(new Error("store unavailable"));
    sendSessionHandoverPartStepMock.mockResolvedValue("delivered");

    await expect(
      createHandoff(createInbox({ takenOver: true })).tryTransfer(
        selection("deployment-b"),
        state(),
      ),
    ).resolves.toEqual({ kind: "transferred" });
    expect(sendSessionHandoverPartStepMock).toHaveBeenCalledTimes(7);
    expect(reportHandoverPartStuckStepMock.mock.calls).toEqual([
      [
        {
          attemptKey: "owner-1:0",
          error: "store unavailable",
          failures: 5,
          index: 0,
          sessionId: "session-1",
        },
      ],
    ]);
  });

  it("stops sending once the session has ended", async () => {
    installActivation();
    startSuccessorStepMock.mockResolvedValue(STARTED);
    sendSessionHandoverPartStepMock.mockResolvedValue("session-ended");
    const unread: SessionInboxPayload[] = [
      { kind: "send", payload: { message: "Bob's note." } },
      { kind: "send", payload: { message: "Bob's follow-up." } },
    ];

    await expect(
      createHandoff(createInbox({ takenOver: true, unread })).tryTransfer(
        selection("deployment-b"),
        state(),
      ),
    ).resolves.toEqual({ kind: "transferred" });
    expect(sendSessionHandoverPartStepMock).toHaveBeenCalledOnce();
  });

  it("remembers every incompatible target for the rest of the owner run", async () => {
    const inbox = createInbox();
    installActivation(
      { kind: "incompatible", payloads: [], reason: "checkpoint-version" },
      // A successor older than this protocol cannot take over from an owner that keeps its hooks.
      {
        error: { message: "Hook token is already in use", name: "HookConflictError" },
        kind: "failed",
        payloads: [],
      },
    );
    startSuccessorStepMock.mockResolvedValue(STARTED);
    const handoff = createHandoff(inbox);

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "checkpoint-incompatible",
    });
    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "known-incompatible",
    });
    await expect(handoff.tryTransfer(selection("deployment-c"), state())).resolves.toEqual({
      kind: "retained",
      reason: "activation-failed",
    });
    await expect(handoff.tryTransfer(selection("deployment-c"), state())).resolves.toEqual({
      kind: "retained",
      reason: "known-incompatible",
    });
    expect(startSuccessorStepMock.mock.calls.map(([start]) => start.attemptKey)).toEqual([
      "owner-1:0",
      "owner-1:1",
    ]);
    expect(inbox.claimSessionHooks).not.toHaveBeenCalled();
    expect(reportSessionHandoffRetainedStepMock.mock.calls.map(([report]) => report)).toEqual([
      expect.objectContaining({
        reason: "checkpoint-incompatible",
        targetDeploymentId: "deployment-b",
      }),
      expect.objectContaining({ reason: "activation-failed", targetDeploymentId: "deployment-c" }),
    ]);
  });

  it("stops attempting for the owner's lifetime on a World that cannot force-claim hooks", async () => {
    installActivation();
    startSuccessorStepMock.mockResolvedValue({ kind: "unsupported" });
    const handoff = createHandoff(createInbox());

    await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
      kind: "retained",
      reason: "unsupported-world",
    });
    await expect(handoff.tryCompactionTransfer(state())).resolves.toEqual({
      kind: "retained",
      reason: "unsupported-world",
    });
    expect(startSuccessorStepMock).toHaveBeenCalledTimes(1);
    expect(reportSessionHandoffRetainedStepMock).not.toHaveBeenCalled();
  });

  it("attempts again on every turn after a generic activation failure", async () => {
    const failure = {
      error: new Error("unsupported checkpoint"),
      kind: "failed",
      payloads: [],
    } as const;
    installActivation(failure, failure);
    startSuccessorStepMock.mockResolvedValue(STARTED);
    const handoff = createHandoff(createInbox());

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(handoff.tryTransfer(selection("deployment-b"), state())).resolves.toEqual({
        kind: "retained",
        reason: "activation-failed",
      });
    }
    expect(startSuccessorStepMock).toHaveBeenCalledTimes(2);
    expect(reportSessionHandoffRetainedStepMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: "unsupported checkpoint", reason: "activation-failed" }),
    );
  });
});

const created: { token: string; dispose: ReturnType<typeof vi.fn> }[] = [];
/** The run already holding the attempt lease, if any. */
let leaseHolder: string | undefined;

/**
 * Like a real hook, each await of an activation hook takes the next verdict;
 * once they run out it never answers.
 */
function installActivation(...verdicts: SessionOwnerActivation[]): void {
  created.length = 0;
  leaseHolder = undefined;
  const remaining = [...verdicts];
  createHookMock.mockImplementation((options: { token: string }) => {
    const isLease = options.token.startsWith("eve:handoff:lease:");
    const next = (): Promise<unknown> => {
      if (options.token.endsWith(":anchor")) return Promise.resolve({ output: "done" });
      const verdict = isLease ? undefined : remaining.shift();
      return verdict === undefined ? new Promise(() => {}) : Promise.resolve(verdict);
    };
    const conflict = isLease ? leaseHolder : undefined;
    const hook = {
      // oxlint-disable-next-line unicorn/no-thenable -- Workflow hooks are awaited for each payload.
      then: (...handlers: Parameters<Promise<unknown>["then"]>) => next().then(...handlers),
      dispose: vi.fn(),
      getConflict: vi.fn(async () => (conflict === undefined ? null : { runId: conflict })),
      token: options.token,
    };
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

function state() {
  return {
    admittedDeliveryKeys: [],
    history: [],
    serializedContext: {},
    sessionState: createTestSessionState({
      continuationToken: "channel:current",
      sessionId: "session-1",
    }),
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

function createInbox(
  input: {
    readonly awaitingHandover?: boolean;
    readonly takenOver?: boolean;
    readonly unread?: SessionInboxPayload[];
    readonly whenTakenOver?: Promise<void>;
    readonly hasPending?: () => boolean;
  } = {},
): SessionInboxHandle {
  return {
    abandonHandover: vi.fn(),
    awaitingHandover: input.awaitingHandover ?? false,
    takenOver: false,
    whenHandoverSettled: () => new Promise<void>(() => {}),
    claimSessionHook: vi.fn(async () => {}),
    claimSessionHooks: vi.fn(async () => {}),
    claimedTokens: TOKENS,
    takeLeading: () => [],
    dispose: vi.fn(async () => {}),
    drain: vi.fn(() => input.unread ?? []),
    hasPending: vi.fn(input.hasPending ?? (() => false)),
    whenPending: () => new Promise<void>(() => {}),
    whenArrival: () => new Promise<void>((resolve) => arrivals.push(resolve)),
    whenBlockedOnHandover: () => new Promise<void>(() => {}),
    whenTakenOver: () =>
      input.whenTakenOver ??
      (input.takenOver === true ? Promise.resolve() : new Promise<void>(() => {})),
    next: vi.fn(),
    onDelivery: vi.fn(() => () => {}),
    onInterrupt: vi.fn(() => () => {}),
    release: vi.fn(async () => []),
    restore: vi.fn(),
  };
}
