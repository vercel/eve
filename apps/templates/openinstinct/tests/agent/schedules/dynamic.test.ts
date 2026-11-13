import {
  SessionNotActiveError,
  type Delivery,
  type Session,
} from "eve/sessions";
import type { ScheduleHandlerArgs, ScheduleToFn } from "eve/schedules";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  claimReadyScheduledAgentRuns,
  claimScheduledReport,
  finalizeScheduledReport,
  listRecoverableScheduledReports,
  materializeDueScheduledAgentRuns,
  releaseScheduledAgentRun,
  releaseScheduledReport,
  setScheduledRunSession,
} from "@db/services/scheduled-agent-jobs";

const services = vi.hoisted(() => ({
  claimReports: vi.fn<typeof claimScheduledReport>(),
  claimRuns: vi.fn<typeof claimReadyScheduledAgentRuns>(),
  finalizeReport: vi.fn<typeof finalizeScheduledReport>(),
  listReports: vi.fn<typeof listRecoverableScheduledReports>(),
  materialize: vi.fn<typeof materializeDueScheduledAgentRuns>(),
  releaseReport: vi.fn<typeof releaseScheduledReport>(),
  releaseRun: vi.fn<typeof releaseScheduledAgentRun>(),
  setSession: vi.fn<typeof setScheduledRunSession>(),
}));
const requests = vi.hoisted(() => ({
  report: vi.fn<(runId: string) => Promise<void>>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  claimReadyScheduledAgentRuns: services.claimRuns,
  claimScheduledReport: services.claimReports,
  finalizeScheduledReport: services.finalizeReport,
  listRecoverableScheduledReports: services.listReports,
  materializeDueScheduledAgentRuns: services.materialize,
  releaseScheduledAgentRun: services.releaseRun,
  releaseScheduledReport: services.releaseReport,
  setScheduledRunSession: services.setSession,
}));
vi.mock("@agent/channels/linq", () => ({ default: { channel: "linq" } }));
vi.mock("@agent/lib/schedules/request", () => ({
  postScheduledReport: requests.report,
}));
vi.mock("@agent/channels/scheduled-run", () => ({
  default: { channel: "scheduled-run" },
}));

import dynamicSchedule from "@agent/schedules/dynamic";
import { dispatchScheduledReport } from "@agent/lib/schedules/report";

describe("dynamic schedule dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.materialize.mockResolvedValue([]);
    services.listReports.mockResolvedValue([]);
    services.claimRuns.mockResolvedValue([]);
    services.releaseRun.mockResolvedValue("queued");
    services.setSession.mockResolvedValue(true);
    requests.report.mockResolvedValue();
  });

  it("hands due work directly to the scheduled-run channel", async () => {
    const claim = scheduledClaim();
    services.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(acceptedDelivery());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: false,
      runId: claim.run.id,
    });
    expect(send.mock.calls[0]?.[0]).toContain("Task: Watch the price.");
    expect(send.mock.calls[0]?.[1].auth?.authenticator).toBe(
      "scheduled-worker"
    );
    expect(services.setSession).toHaveBeenCalledExactlyOnceWith(
      claim.run.id,
      claim.run.leaseToken,
      "worker-session"
    );
    expect(services.claimRuns).toHaveBeenCalledWith(
      expect.objectContaining({ leaseForMs: 300_000 })
    );
  });

  it("requests a clean restart for a reclaimed interrupted worker", async () => {
    const claim = scheduledClaim();
    claim.run.workerSessionId = "interrupted-worker-session";
    services.claimRuns.mockResolvedValue([claim]);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(acceptedDelivery());
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      restart: true,
      runId: claim.run.id,
    });
  });

  it("delivers recoverable Linq reports through the schedule channel handle", async () => {
    const report = scheduledReport();
    services.listReports.mockResolvedValue([
      { conversationChannel: "linq", runId: report.run.id },
    ]);
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(acceptedDelivery("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(requests.report).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: { authenticator: "scheduled-result" },
      turnPolicy: "queue",
    });
  });

  it("keeps Eve debug reports on its active-session callback", async () => {
    const report = scheduledReport();
    services.listReports.mockResolvedValue([
      { conversationChannel: "eve", runId: report.run.id },
    ]);
    const to = vi.fn<ScheduleToFn>();

    await runSchedule(to);

    expect(to).not.toHaveBeenCalled();
    expect(requests.report).toHaveBeenCalledExactlyOnceWith(report.run.id);
  });

  it("reports a worker that exhausts its dispatch attempts", async () => {
    const claim = scheduledClaim();
    services.claimRuns.mockResolvedValue([claim]);
    services.releaseRun.mockResolvedValue("dead_letter");
    services.claimReports.mockResolvedValue({
      ...scheduledReport(),
      job: claim.job,
      run: {
        ...scheduledReport().run,
        id: claim.run.id,
      },
    });
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockRejectedValue(new Error("Workflow did not accept the candidate."));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));

    await runSchedule(to);

    expect(services.releaseRun).toHaveBeenCalledWith(
      claim.run.id,
      claim.run.leaseToken,
      "Workflow did not accept the candidate."
    );
    expect(requests.report).not.toHaveBeenCalled();
    expect(services.claimReports).toHaveBeenCalledExactlyOnceWith(claim.run.id);
  });
});

describe("scheduled report delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.releaseReport.mockResolvedValue(true);
  });

  it("routes Linq reports to the stored conversation", async () => {
    const report = scheduledReport();
    report.job.replyAnchorMessageId = "original-message";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<ReturnType<ScheduleToFn>["send"]>()
      .mockResolvedValue(acceptedDelivery("main-session"));
    const to = vi.fn<ScheduleToFn>(() => ({ send }));
    const attachSession = vi.fn<(sessionId: string) => Session>();

    await dispatchScheduledReport({ attachSession, to }, report.run.id);

    expect(to).toHaveBeenCalledWith(expect.anything(), {
      adapterName: "linq",
      threadId: "linq:dm:chat-1",
    });
    expect(attachSession).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth: {
        attributes: {
          linqReplyAnchorMessageId: "original-message",
          scheduleId: report.job.id,
        },
        authenticator: "scheduled-result",
      },
      turnPolicy: "queue",
    });
    expect(send.mock.calls[0]?.[0]).toContain(
      `Reply handle: {"kind":"automation","id":"${report.job.id}"}`
    );
    expect(send.mock.calls[0]?.[0]).toContain(
      "Pass this exact value as send_message.replyTo for every user-visible message about this scheduled task."
    );
  });

  it("routes Eve reports to the stored debug session", async () => {
    const report = scheduledReport();
    report.job.conversationChannel = "eve";
    report.job.conversationId = "web-session";
    services.claimReports.mockResolvedValue(report);
    const send = vi.fn<Session["send"]>();
    const attached = attachedSession("web-session", send);
    send.mockResolvedValue(acceptedDelivery("web-session"));
    const attachSession = vi
      .fn<(sessionId: string) => Session>()
      .mockReturnValue(attached);
    const to = vi.fn<ScheduleToFn>();

    await dispatchScheduledReport({ attachSession, to }, report.run.id);

    expect(attachSession).toHaveBeenCalledExactlyOnceWith("web-session");
    expect(to).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toContain(
      "A background scheduled run has completed."
    );
    expect(send.mock.calls[0]?.[1].auth?.authenticator).toBe(
      "scheduled-result"
    );
    expect(send.mock.calls[0]?.[1].turnPolicy).toBe("queue");
  });

  it("suppresses reports for inactive Eve debug sessions", async () => {
    const report = scheduledReport();
    report.job.conversationChannel = "eve";
    report.job.conversationId = "retired-session";
    services.claimReports.mockResolvedValue(report);
    const send = vi
      .fn<Session["send"]>()
      .mockRejectedValue(new SessionNotActiveError());
    const attachSession = vi
      .fn<(sessionId: string) => Session>()
      .mockReturnValue(attachedSession("retired-session", send));

    await dispatchScheduledReport(
      { attachSession, to: vi.fn<ScheduleToFn>() },
      report.run.id
    );

    expect(services.finalizeReport).toHaveBeenCalledExactlyOnceWith(
      report.run.id,
      report.run.reportLeaseToken,
      "suppressed"
    );
  });
});

async function runSchedule(to: ScheduleToFn) {
  let task: Promise<unknown> | undefined;
  const args: ScheduleHandlerArgs = {
    appAuth: {
      attributes: {},
      authenticator: "test",
      principalId: "test-app",
      principalType: "app",
    },
    to,
    waitUntil(backgroundTask) {
      task = backgroundTask;
    },
  };
  dynamicSchedule.run(args);
  await task;
}

const resultOutcome = {
  kind: "result" as const,
  summary: "The price fell to $250.",
  urgency: "normal" as const,
};

function acceptedDelivery(sessionId = "worker-session"): Delivery {
  return {
    deliveryId: `${sessionId}-delivery`,
    result: vi.fn<Delivery["result"]>(),
    sessionId,
    stream: vi.fn<Delivery["stream"]>(),
  };
}

function attachedSession(id: string, send = vi.fn<Session["send"]>()): Session {
  return {
    cancel: vi.fn<Session["cancel"]>(),
    clear: vi.fn<Session["clear"]>(),
    compact: vi.fn<Session["compact"]>(),
    end: vi.fn<Session["end"]>(),
    id,
    prewarm: vi.fn<Session["prewarm"]>(),
    respond: vi.fn<Session["respond"]>(),
    send,
    stream: vi.fn<Session["stream"]>(),
  };
}

function scheduledClaim(): Awaited<
  ReturnType<typeof claimReadyScheduledAgentRuns>
>[number] {
  return {
    job: {
      createdAt: new Date("2026-09-01T12:00:00.000Z"),
      createdByUserId: "user-1",
      id: "00000000-0000-4000-8000-000000000001",
      lastError: null,
      lastRunAt: new Date("2026-09-02T13:00:00.000Z"),
      conversationChannel: "linq",
      conversationId: "linq:dm:chat-1",
      missedRunPolicy: "run_latest",
      nextRunAt: new Date("2026-09-03T13:00:00.000Z"),
      prompt: "Watch the price.",
      replyAnchorMessageId: null,
      revision: 0,
      status: "active",
      timing: {
        frequency: "daily",
        kind: "calendar",
        localTime: "09:00",
        timezone: "America/New_York",
      },
      updatedAt: new Date("2026-09-01T12:00:00.000Z"),
      workspaceId: "workspace-1",
    },
    run: {
      attempts: 1,
      completedAt: null,
      createdAt: new Date("2026-09-02T13:00:00.000Z"),
      deferredCompletionTurnId: null,
      id: "00000000-0000-4000-8000-000000000002",
      pendingInputRequests: null,
      jobId: "00000000-0000-4000-8000-000000000001",
      lastError: null,
      leaseExpiresAt: new Date("2026-09-02T13:05:00.000Z"),
      leaseToken: "00000000-0000-4000-8000-000000000003",
      outcome: null,
      reportStatus: "not_ready",
      reportSequence: 0,
      reportLeaseExpiresAt: null,
      reportLeaseToken: null,
      retryAt: null,
      scheduledFor: new Date("2026-09-02T13:00:00.000Z"),
      startedAt: null,
      status: "running",
      updatedAt: new Date("2026-09-02T13:00:00.000Z"),
      workerSessionId: null,
    },
  };
}

function scheduledReport(): NonNullable<
  Awaited<ReturnType<typeof claimScheduledReport>>
> {
  const claim = scheduledClaim();
  return {
    job: claim.job,
    run: {
      ...claim.run,
      outcome: resultOutcome,
      reportSequence: 1,
      reportStatus: "queued",
      reportLeaseToken: "00000000-0000-4000-8000-000000000004",
      status: "completed",
    },
  };
}
