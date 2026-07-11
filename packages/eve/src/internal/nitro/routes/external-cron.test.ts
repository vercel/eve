import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#internal/nitro/routes/schedule-task.js", () => ({
  dispatchScheduleTask: vi.fn(async (taskName: string) => ({
    scheduleId: taskName.replace("eve.schedule.", ""),
    sessionIds: [`session-for-${taskName}`],
  })),
}));

import { dispatchScheduleTask } from "#internal/nitro/routes/schedule-task.js";
import {
  EXTERNAL_CRON_SCHEDULE_HEADER,
  handleExternalCronRequest,
  type ExternalCronRouteConfig,
} from "#internal/nitro/routes/external-cron.js";

const CONFIG: ExternalCronRouteConfig = {
  artifactsConfig: { appRoot: "/tmp/test-agent", dev: false },
  schedules: [
    { cron: "0 8 * * *", name: "daily", taskName: "eve.schedule.daily" },
    { cron: "0 8 * * *", name: "digest", taskName: "eve.schedule.digest" },
    { cron: "*/5 * * * *", name: "heartbeat", taskName: "eve.schedule.heartbeat" },
  ],
};

function createRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/eve/v1/cron/test-token", {
    headers,
    method: "POST",
  });
}

describe("handleExternalCronRequest", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("dispatches every schedule registered for the due cron expression", async () => {
    const response = await handleExternalCronRequest(
      CONFIG,
      createRequest({ [EXTERNAL_CRON_SCHEDULE_HEADER]: "0 8 * * *" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      dispatched: [
        { scheduleId: "daily", sessionIds: ["session-for-eve.schedule.daily"] },
        { scheduleId: "digest", sessionIds: ["session-for-eve.schedule.digest"] },
      ],
    });
    expect(dispatchScheduleTask).toHaveBeenCalledTimes(2);
    expect(dispatchScheduleTask).toHaveBeenCalledWith("eve.schedule.daily", CONFIG.artifactsConfig);
  });

  it("succeeds with an empty dispatch list for an unknown cron expression", async () => {
    const response = await handleExternalCronRequest(
      CONFIG,
      createRequest({ [EXTERNAL_CRON_SCHEDULE_HEADER]: "59 23 * * *" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, dispatched: [] });
    expect(dispatchScheduleTask).not.toHaveBeenCalled();
  });

  it("rejects requests without the cron schedule header", async () => {
    const response = await handleExternalCronRequest(CONFIG, createRequest());

    expect(response.status).toBe(400);
    expect(dispatchScheduleTask).not.toHaveBeenCalled();
  });

  it("enforces CRON_SECRET as a bearer token when configured", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");

    const missingAuth = await handleExternalCronRequest(
      CONFIG,
      createRequest({ [EXTERNAL_CRON_SCHEDULE_HEADER]: "*/5 * * * *" }),
    );
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await handleExternalCronRequest(
      CONFIG,
      createRequest({
        [EXTERNAL_CRON_SCHEDULE_HEADER]: "*/5 * * * *",
        authorization: "Bearer wrong",
      }),
    );
    expect(wrongAuth.status).toBe(401);
    expect(dispatchScheduleTask).not.toHaveBeenCalled();

    const authorized = await handleExternalCronRequest(
      CONFIG,
      createRequest({
        [EXTERNAL_CRON_SCHEDULE_HEADER]: "*/5 * * * *",
        authorization: "Bearer s3cret",
      }),
    );
    expect(authorized.status).toBe(200);
    expect(dispatchScheduleTask).toHaveBeenCalledWith(
      "eve.schedule.heartbeat",
      CONFIG.artifactsConfig,
    );
  });
});
