import type * as EveTools from "eve/tools";
import type { DynamicContext, ToolContext, ToolDefinition } from "eve/tools";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dynamicContextFor,
  dynamicTool,
  evaluateDynamic,
  withEvaluableDynamic,
} from "@tests/helpers/dynamic";
import { toolContextFor } from "@tests/helpers/tool-context";

vi.mock("eve/tools", async (importOriginal) =>
  withEvaluableDynamic(await importOriginal<typeof EveTools>())
);
import type {
  createScheduledAgentJob,
  getScheduledAgentRunInput,
  getScheduledAgentRunInputForReport,
  listScheduledAgentJobs,
  updateScheduledAgentJob,
} from "@db/services/scheduled-agent-jobs";

const services = vi.hoisted(() => ({
  create: vi.fn<typeof createScheduledAgentJob>(),
  getInput: vi.fn<typeof getScheduledAgentRunInput>(),
  getInputForReport: vi.fn<typeof getScheduledAgentRunInputForReport>(),
  list: vi.fn<typeof listScheduledAgentJobs>(),
  update: vi.fn<typeof updateScheduledAgentJob>(),
}));

vi.mock("@db/services/scheduled-agent-jobs", () => ({
  createScheduledAgentJob: services.create,
  getScheduledAgentRunInput: services.getInput,
  getScheduledAgentRunInputForReport: services.getInputForReport,
  listScheduledAgentJobs: services.list,
  updateScheduledAgentJob: services.update,
}));

import messaging from "@agent/tools/messaging";
import schedules, {
  createSchedule,
  listSchedules,
  updateSchedule,
} from "@agent/tools/schedules";

describe("schedule tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 202 }))
    );
  });

  it("lets interactive and reporting turns resume scheduled input", async () => {
    expect(
      await evaluateDynamic(schedules, dynamicContext("scheduled-worker"))
    ).toBeNull();
    expect(await evaluateDynamic(schedules, resumedWorkerContext())).toBeNull();
    expect(
      await evaluateDynamic(schedules, dynamicContext("scheduled-result"))
    ).not.toBeNull();
    const interactiveTools = await evaluateDynamic(
      schedules,
      dynamicContext("linq")
    );
    const answer = dynamicTool(interactiveTools, "schedules-answer");
    services.getInput.mockResolvedValue({
      leaseToken: "00000000-0000-4000-8000-000000000003",
      runId: "00000000-0000-4000-8000-000000000002",
    });
    await answer.execute(
      {
        answer: "DCA",
        runId: "00000000-0000-4000-8000-000000000002",
      },
      toolContext("schedules-answer", "linq")
    );
    expect(services.getInput).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        conversationChannel: "linq",
        conversationId: "linq:dm:chat-1",
      },
      "00000000-0000-4000-8000-000000000002"
    );

    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/internal/scheduled-run/respond"),
      expect.objectContaining({ method: "POST" })
    );

    services.getInputForReport.mockResolvedValue({
      leaseToken: "00000000-0000-4000-8000-000000000003",
      runId: "00000000-0000-4000-8000-000000000002",
    });
    const reportTools = await evaluateDynamic(
      schedules,
      dynamicContext("scheduled-result")
    );
    const reportAnswer = dynamicTool(reportTools, "schedules-answer");
    await reportAnswer.execute(
      {
        answer: "LGA",
        runId: "00000000-0000-4000-8000-000000000002",
      },
      scheduledReportToolContext()
    );
    expect(services.getInputForReport).toHaveBeenCalledExactlyOnceWith(
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000004"
    );

    await expect(
      reportAnswer.execute(
        {
          answer: "LGA",
          runId: "00000000-0000-4000-8000-000000000002",
        },
        toolContext("schedules-answer", "scheduled-result")
      )
    ).rejects.toThrow("This reporting turn cannot resume that run.");
    expect(services.getInput).toHaveBeenCalledOnce();
  });

  it("does not report a scheduled answer as resumed when the callback hits an HTML fallback", async () => {
    services.getInput.mockResolvedValue({
      leaseToken: "00000000-0000-4000-8000-000000000003",
      runId: "00000000-0000-4000-8000-000000000002",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response("<h1>404</h1>", { status: 200 })
    );
    const tools = await evaluateDynamic(schedules, dynamicContext("linq"));
    await expect(
      dynamicTool(tools, "schedules-answer").execute(
        { answer: "Beta", runId: "00000000-0000-4000-8000-000000000002" },
        toolContext("schedules-answer", "linq")
      )
    ).rejects.toThrow("The scheduled task could not be resumed.");
  });

  it("creates a schedule without a multiplexed action field", async () => {
    const job = scheduledJob();
    services.create.mockResolvedValue(job);

    const result = await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      },
      toolContext("schedules-create")
    );

    expect(inputProperties(createSchedule.inputSchema)).toEqual([
      "missedRunPolicy",
      "prompt",
      "timing",
    ]);
    expect(services.create).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        conversationChannel: "linq",
        conversationId: "linq:dm:chat-1",
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        replyAnchorMessageId: "message-1",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      }
    );
    expect(result).toEqual(scheduleSummary(job));
  });

  it("lists schedules through a dedicated empty-input tool", async () => {
    const job = scheduledJob();
    services.list.mockResolvedValue([job]);

    const result = await listSchedules.execute(
      {},
      toolContext("schedules-list")
    );

    expect(inputProperties(listSchedules.inputSchema)).toEqual([]);
    expect(services.list).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        conversationChannel: "linq",
        conversationId: "linq:dm:chat-1",
      }
    );
    expect(result).toEqual([scheduleListSummary(job)]);
  });

  it("updates a schedule without carrying an action discriminator", async () => {
    const job = scheduledJob();
    services.update.mockResolvedValue(job);

    const result = await updateSchedule.execute(
      {
        id: job.id,
        status: "paused",
      },
      toolContext("schedules-update")
    );

    expect(inputProperties(updateSchedule.inputSchema)).toEqual([
      "id",
      "prompt",
      "status",
      "timing",
    ]);
    expect(services.update).toHaveBeenCalledExactlyOnceWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      {
        conversationChannel: "linq",
        conversationId: "linq:dm:chat-1",
      },
      job.id,
      { status: "paused" }
    );
    expect(result).toEqual(scheduleSummary(job));
  });

  it("omits messaging capabilities outside their valid turns", async () => {
    expect(
      await evaluateDynamic(messaging, dynamicContext("scheduled-worker"))
    ).toBeNull();
    expect(await evaluateDynamic(messaging, resumedWorkerContext())).toBeNull();
    const reportMessaging = await evaluateDynamic(
      messaging,
      dynamicContext("scheduled-result", "channel:linq")
    );
    expect(Object.keys(reportMessaging ?? {})).toEqual(["send_message"]);

    const debugMessaging = await evaluateDynamic(
      messaging,
      dynamicContext("test", "channel:eve")
    );
    const interactiveMessaging = await evaluateDynamic(
      messaging,
      dynamicContext("test", "channel:linq")
    );
    expect(Object.keys(debugMessaging ?? {}).toSorted()).toEqual([
      "react_to_message",
      "send_message",
      "share_contact",
    ]);
    expect(Object.keys(interactiveMessaging ?? {}).toSorted()).toEqual([
      "react_to_message",
      "send_message",
      "share_contact",
    ]);
    const reportSend = dynamicTool(reportMessaging, "send_message");
    const interactiveSend = dynamicTool(interactiveMessaging, "send_message");
    const debugSend = dynamicTool(debugMessaging, "send_message");
    if (
      !(reportSend.inputSchema instanceof z.ZodType) ||
      !(interactiveSend.inputSchema instanceof z.ZodType) ||
      !(debugSend.inputSchema instanceof z.ZodType)
    ) {
      throw new Error("Expected authored send_message schemas.");
    }
    const reply = {
      kind: "message",
      replyTo: { kind: "current" as const },
      text: "This one.",
    };
    expect(interactiveSend.inputSchema.safeParse(reply).success).toBe(true);
    expect(debugSend.inputSchema.safeParse(reply).success).toBe(true);
    expect(reportSend.inputSchema.safeParse(reply).success).toBe(true);
  });

  it("owns web schedules by their Eve session", async () => {
    const job = scheduledJob({
      conversationChannel: "eve",
      conversationId: "session-1",
    });
    services.create.mockResolvedValue(job);

    await createSchedule.execute(
      {
        missedRunPolicy: "run_latest",
        prompt: "Send the morning summary.",
        timing: {
          frequency: "daily",
          kind: "calendar",
          localTime: "09:00",
          timezone: "America/New_York",
        },
      },
      toolContext("schedules-create", "test", "eve")
    );

    expect(services.create).toHaveBeenCalledWith(
      { userId: "user-1", workspaceId: "workspace-1" },
      expect.objectContaining({
        conversationChannel: "eve",
        conversationId: "session-1",
      })
    );
  });
});

function dynamicContext(
  authenticator: string,
  kind: DynamicContext["channel"]["kind"] = "channel:scheduled-run"
) {
  return dynamicContextFor({
    auth: {
      current: {
        attributes: {},
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    channel: { kind, metadata: {} },
    sessionId: "session-1",
  });
}

function resumedWorkerContext() {
  const context = dynamicContext("linq");
  return dynamicContextFor({
    auth: {
      ...context.session.auth,
      initiator: {
        attributes: {},
        authenticator: "scheduled-worker",
        principalId: "user-1",
        principalType: "user",
      },
    },
    channel: context.channel,
    sessionId: context.session.id,
  });
}

function toolContext(
  toolName: string,
  authenticator = "test",
  conversationChannel: "eve" | "linq" = "linq",
  attributes: Record<string, string> = {}
): ToolContext {
  return toolContextFor({
    auth: {
      current: {
        attributes: {
          conversationChannel,
          conversationId: "linq:dm:chat-1",
          linqMessageId: "message-1",
          linqThreadId: "linq:dm:chat-1",
          workspaceId: "workspace-1",
          ...attributes,
        },
        authenticator,
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    callId: "call-schedule",
    sessionId: "session-1",
    toolName,
  });
}

function scheduledReportToolContext() {
  return toolContext("schedules-answer", "scheduled-result", "linq", {
    scheduleId: "00000000-0000-4000-8000-000000000001",
    scheduledReportLeaseToken: "00000000-0000-4000-8000-000000000004",
    scheduledReportSequence: "1",
    scheduledRunId: "00000000-0000-4000-8000-000000000002",
  });
}

function inputProperties(schema: ToolDefinition["inputSchema"]) {
  if (!(schema instanceof z.ZodType)) {
    throw new TypeError("Expected an authored Zod input schema.");
  }
  return Object.keys(z.toJSONSchema(schema).properties ?? {});
}

function scheduledJob(
  conversation: {
    conversationChannel: "eve" | "linq";
    conversationId: string;
  } = {
    conversationChannel: "linq",
    conversationId: "linq:dm:chat-1",
  }
): Awaited<ReturnType<typeof listScheduledAgentJobs>>[number] {
  return {
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    createdByUserId: "user-1",
    id: "00000000-0000-4000-8000-000000000001",
    lastError: null,
    lastRunAt: null,
    latestRun: null,
    ...conversation,
    missedRunPolicy: "run_latest",
    nextRunAt: new Date("2026-09-02T13:00:00.000Z"),
    prompt: "Send the morning summary.",
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
  };
}

function scheduleSummary(job: ReturnType<typeof scheduledJob>) {
  return {
    createdAt: job.createdAt.toISOString(),
    id: job.id,
    lastError: job.lastError,
    lastRunAt: job.lastRunAt?.toISOString() ?? null,
    nextRunAt: job.nextRunAt?.toISOString() ?? null,
    prompt: job.prompt,
    status: job.status,
    timing: job.timing,
  };
}

function scheduleListSummary(job: ReturnType<typeof scheduledJob>) {
  return { ...scheduleSummary(job), latestRun: null };
}
