import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  openInteractions,
  type Fact,
  type SessionView,
  type TurnSettled,
} from "eve/events";
import type { HookContext } from "eve/hooks";
import type {
  completeScheduledAgentRun,
  markScheduledAgentRunStarted,
  releaseScheduledAgentRun,
  waitForScheduledAgentRunInput,
} from "@db/services/scheduled-agent-jobs";
import { hookContextFor } from "@tests/helpers/hook-context";
import { viewOf } from "@tests/helpers/session-view";

const services = vi.hoisted(() => ({
  complete: vi.fn<typeof completeScheduledAgentRun>(),
  markStarted: vi.fn<typeof markScheduledAgentRunStarted>(),
  release: vi.fn<typeof releaseScheduledAgentRun>(),
  waitForInput: vi.fn<typeof waitForScheduledAgentRunInput>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  completeScheduledAgentRun: services.complete,
  markScheduledAgentRunStarted: services.markStarted,
  releaseScheduledAgentRun: services.release,
  waitForScheduledAgentRunInput: services.waitForInput,
}));

import completionHook from "@agent/hooks/scheduled-run-completion";

const runId = "00000000-0000-4000-8000-000000000001";
const leaseToken = "00000000-0000-4000-8000-000000000002";
const retryLeaseToken = "00000000-0000-4000-8000-000000000005";
type SessionAuth = HookContext["session"]["auth"];

const workerAuth: SessionAuth = {
  current: null,
  initiator: {
    attributes: {
      scheduledRunId: runId,
      scheduledRunLeaseToken: leaseToken,
    },
    authenticator: "scheduled-worker",
    principalId: "user-1",
    principalType: "user",
  },
};

const resumedAuth: SessionAuth = {
  ...workerAuth,
  current: {
    attributes: {},
    authenticator: "linq",
    principalId: "user-1",
    principalType: "user",
  },
};

const retriedAuth: SessionAuth = {
  ...workerAuth,
  current: {
    attributes: {
      scheduledRunId: runId,
      scheduledRunLeaseToken: retryLeaseToken,
    },
    authenticator: "scheduled-worker",
    principalId: "user-1",
    principalType: "user",
  },
};

function workerContext(
  now: string,
  {
    auth = workerAuth,
    turnId = "turn-1",
    view,
  }: {
    readonly auth?: SessionAuth;
    readonly turnId?: string;
    readonly view?: SessionView;
  } = {}
) {
  return hookContextFor({
    auth,
    channel: {
      continuationToken: `scheduled-run:${runId}`,
      kind: "channel:scheduled-run",
      metadata: {},
    },
    now: new Date(now),
    sessionId: "worker-session",
    turnId,
    view,
  });
}

interface TestPart {
  readonly partId: string;
  readonly phase?: "narration" | "reply";
  readonly value: string;
  readonly interrupted?: true;
}

/** A completed worker turn whose reply holds the given parts. */
function settledTurn(turnId: string, parts: readonly TestPart[]) {
  const settled: TurnSettled = {
    data: {
      outcome: "completed",
      reply: parts
        .filter((part) => part.phase !== "narration")
        .map((part) => part.partId),
      turnId,
    },
    scope: { turnId },
    type: "turn.settled",
  };
  const lines: Fact[][] = [
    [
      {
        data: { cause: { deliveryId: "delivery-1" }, follows: null, turnId },
        scope: { turnId },
        type: "turn.started",
      },
    ],
    ...parts.map((part): Fact[] => [
      {
        data: {
          interrupted: part.interrupted,
          kind: "text",
          partId: part.partId,
          phase: part.phase ?? "reply",
          runId: "run-1",
          value: part.value,
        },
        scope: { runId: "run-1", turnId },
        type: "content.completed",
      },
    ]),
    [settled],
  ];
  return { event: settled, view: viewOf(lines) };
}

const completedRun = {
  attempts: 1,
  completedAt: new Date("2026-09-01T13:02:00.000Z"),
  createdAt: new Date("2026-09-01T13:00:00.000Z"),
  deferredCompletionTurnId: null,
  id: runId,
  pendingInputRequests: null,
  jobId: "00000000-0000-4000-8000-000000000003",
  lastError: null,
  leaseExpiresAt: null,
  leaseToken: null,
  outcome: {
    kind: "result" as const,
    summary: "The price fell to $250.",
    urgency: "normal" as const,
  },
  reportStatus: "pending" as const,
  reportSequence: 1,
  reportLeaseExpiresAt: null,
  reportLeaseToken: null,
  retryAt: null,
  scheduledFor: new Date("2026-09-01T13:00:00.000Z"),
  startedAt: new Date("2026-09-01T13:00:00.000Z"),
  status: "completed" as const,
  updatedAt: new Date("2026-09-01T13:02:00.000Z"),
  workerSessionId: "worker-session",
};

beforeEach(() => {
  vi.clearAllMocks();
  services.markStarted.mockResolvedValue(true);
  services.release.mockResolvedValue("queued");
});

describe("scheduled run completion hook", () => {
  it("starts the runtime lease only when the worker turn begins", async () => {
    const handler = completionHook.events["turn.started"];
    await handler?.(
      {
        data: {
          cause: { deliveryId: "delivery-1" },
          follows: null,
          turnId: "turn-1",
        },
        scope: { turnId: "turn-1" },
        type: "turn.started",
      },
      workerContext("2026-09-01T13:00:05.000Z")
    );

    expect(services.markStarted).toHaveBeenCalledExactlyOnceWith(
      runId,
      leaseToken,
      "worker-session",
      21_600_000,
      new Date("2026-09-01T13:00:05.000Z")
    );
  });

  it("uses a retry turn's current lease over the original session lease", async () => {
    const handler = completionHook.events["turn.started"];
    await handler?.(
      {
        data: {
          cause: { deliveryId: "delivery-2" },
          follows: "turn-1",
          turnId: "turn-2",
        },
        scope: { turnId: "turn-2" },
        type: "turn.started",
      },
      workerContext("2026-09-01T13:05:05.000Z", {
        auth: retriedAuth,
        turnId: "turn-2",
      })
    );

    expect(services.markStarted).toHaveBeenCalledExactlyOnceWith(
      runId,
      retryLeaseToken,
      "worker-session",
      21_600_000,
      new Date("2026-09-01T13:05:05.000Z")
    );
  });

  it("persists the outcome for durable report delivery", async () => {
    services.complete.mockResolvedValue({
      run: completedRun,
    });
    const { event, view } = settledTurn("turn-1", [
      { partId: "part-1", value: "The price fell to $250." },
    ]);
    await completionHook.events["turn.settled"]?.(
      event,
      workerContext("2026-09-01T13:02:00.000Z", { view })
    );

    expect(services.complete).toHaveBeenCalledWith(
      runId,
      leaseToken,
      {
        kind: "result",
        summary: "The price fell to $250.",
        urgency: "normal",
      },
      new Date("2026-09-01T13:02:00.000Z")
    );
  });

  it("ignores narration emitted before a tool call completes", async () => {
    services.complete.mockResolvedValue({
      run: completedRun,
    });
    const { event, view } = settledTurn("turn-1", [
      {
        partId: "part-1",
        phase: "narration",
        value: "I will check that now.",
      },
      { partId: "part-2", value: "The price fell to $250." },
    ]);
    await completionHook.events["turn.settled"]?.(
      event,
      workerContext("2026-09-01T13:01:00.000Z", { view })
    );

    expect(services.complete).toHaveBeenCalledWith(
      runId,
      leaseToken,
      {
        kind: "result",
        summary: "The price fell to $250.",
        urgency: "normal",
      },
      new Date("2026-09-01T13:01:00.000Z")
    );
  });

  it("retries a non-success model boundary instead of completing it", async () => {
    const { event, view } = settledTurn("turn-1", [
      {
        interrupted: true,
        partId: "part-1",
        value: "This response was truncated",
      },
    ]);
    await completionHook.events["turn.settled"]?.(
      event,
      workerContext("2026-09-01T13:01:00.000Z", { view })
    );

    expect(services.complete).not.toHaveBeenCalled();
    expect(services.release).toHaveBeenCalledExactlyOnceWith(
      runId,
      leaseToken,
      "Scheduled worker stopped before finishing its reply.",
      new Date("2026-09-01T13:01:00.000Z")
    );
  });

  it("bounds a long final handoff before persisting it", async () => {
    const { event, view } = settledTurn("turn-1", [
      { partId: "part-1", value: "a".repeat(4_001) },
    ]);
    await completionHook.events["turn.settled"]?.(
      event,
      workerContext("2026-09-01T13:01:00.000Z", { view })
    );

    expect(services.complete).toHaveBeenCalledWith(
      runId,
      leaseToken,
      {
        kind: "result",
        summary: "a".repeat(4_000),
        urgency: "normal",
      },
      new Date("2026-09-01T13:01:00.000Z")
    );
  });

  it("parks the worker and queues its question for delivery", async () => {
    const view = viewOf([
      [
        {
          data: {
            cause: { deliveryId: "delivery-1" },
            follows: null,
            turnId: "turn-1",
          },
          scope: { turnId: "turn-1" },
          type: "turn.started",
        },
      ],
      [
        {
          data: {
            callId: "call-1",
            capability: { kind: "tool", name: "ask_question" },
            input: { prompt: "Which airport?" },
            owner: { runId: "run-1" },
          },
          scope: { runId: "run-1", turnId: "turn-1" },
          type: "call.requested",
        },
        {
          data: {
            interactionId: "request-1",
            request: {
              allowFreeform: true,
              kind: "question",
              prompt: "Which airport?",
            },
            subject: { callId: "call-1" },
          },
          scope: { runId: "run-1", turnId: "turn-1" },
          type: "interaction.opened",
        },
        {
          data: {
            interactionId: "sign-in-1",
            request: {
              kind: "sign-in",
              prompt: "Sign in to Google.",
              signIn: { name: "google" },
            },
            subject: { turnId: "turn-1" },
          },
          scope: { turnId: "turn-1" },
          type: "interaction.opened",
        },
        {
          data: {
            awaiting: [
              { interactionId: "request-1" },
              { interactionId: "sign-in-1" },
            ],
            turnId: "turn-1",
          },
          scope: { turnId: "turn-1" },
          type: "turn.paused",
        },
      ],
    ]);
    const requests = openInteractions(view).filter(
      ({ request }) => request.kind !== "sign-in"
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      interactionId: "request-1",
      request: { kind: "question", prompt: "Which airport?" },
    });
    services.waitForInput.mockResolvedValue({
      ...completedRun,
      completedAt: null,
      leaseToken,
      outcome: null,
      pendingInputRequests: requests,
      status: "waiting_for_input",
      updatedAt: new Date("2026-09-01T13:01:00.000Z"),
    });
    await completionHook.events["turn.paused"]?.(
      {
        data: {
          awaiting: [
            { interactionId: "request-1" },
            { interactionId: "sign-in-1" },
          ],
          turnId: "turn-1",
        },
        scope: { turnId: "turn-1" },
        type: "turn.paused",
      },
      workerContext("2026-09-01T13:01:00.000Z", { view })
    );

    expect(services.waitForInput).toHaveBeenCalledWith(
      runId,
      leaseToken,
      requests,
      new Date("2026-09-01T13:01:00.000Z")
    );
  });

  it("releases a failed worker for retry", async () => {
    await completionHook.events["turn.settled"]?.(
      {
        data: {
          error: { code: "model_error", message: "Model unavailable." },
          outcome: "failed",
          turnId: "turn-1",
        },
        scope: { turnId: "turn-1" },
        type: "turn.settled",
      },
      workerContext("2026-09-01T13:02:00.000Z")
    );

    expect(services.release).toHaveBeenCalledWith(
      runId,
      leaseToken,
      "Model unavailable.",
      new Date("2026-09-01T13:02:00.000Z")
    );
  });

  it("releases a worker whose session fails outside a turn", async () => {
    await completionHook.events["session.ended"]?.(
      {
        data: {
          error: { code: "session_error", message: "Session crashed." },
          outcome: "failed",
        },
        type: "session.ended",
      },
      workerContext("2026-09-01T13:02:30.000Z")
    );

    expect(services.release).toHaveBeenCalledWith(
      runId,
      leaseToken,
      "Session crashed.",
      new Date("2026-09-01T13:02:30.000Z")
    );
  });

  it("retains the scheduled identity after the user resumes the turn", async () => {
    await completionHook.events["turn.settled"]?.(
      {
        data: {
          error: {
            code: "model_error",
            message: "Model unavailable after resumption.",
          },
          outcome: "failed",
          turnId: "turn-2",
        },
        scope: { turnId: "turn-2" },
        type: "turn.settled",
      },
      workerContext("2026-09-01T13:03:00.000Z", {
        auth: resumedAuth,
        turnId: "turn-2",
      })
    );

    expect(services.release).toHaveBeenCalledWith(
      runId,
      leaseToken,
      "Model unavailable after resumption.",
      new Date("2026-09-01T13:03:00.000Z")
    );
  });
});
