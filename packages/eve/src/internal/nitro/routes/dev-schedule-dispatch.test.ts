import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchScheduleInDev: vi.fn(),
}));

vi.mock("#internal/nitro/host/dispatch-schedule-in-dev.js", async () => {
  const actual = await vi.importActual<
    typeof import("#internal/nitro/host/dispatch-schedule-in-dev.js")
  >("#internal/nitro/host/dispatch-schedule-in-dev.js");
  return {
    ...actual,
    dispatchScheduleInDev: mocks.dispatchScheduleInDev,
  };
});

const APP_ROOT = "/tmp/eve-test";

async function importHandler() {
  return await import("#internal/nitro/routes/dev-schedule-dispatch.js");
}

async function postSchedule(scheduleIdInUrl: string): Promise<Response> {
  const { handleDevScheduleDispatchRequest } = await importHandler();
  const request = new Request(`http://localhost:3000/eve/v1/dev/schedules/${scheduleIdInUrl}`, {
    method: "POST",
  });
  return await handleDevScheduleDispatchRequest({ appRoot: APP_ROOT }, request);
}

describe("handleDevScheduleDispatchRequest", () => {
  it("returns scheduleId and sessionIds from the dev dispatch result", async () => {
    mocks.dispatchScheduleInDev.mockResolvedValueOnce({
      scheduleId: "heartbeat",
      sessionIds: ["sess-1", "sess-2"],
    });

    const response = await postSchedule("heartbeat");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      scheduleId: "heartbeat",
      sessionIds: ["sess-1", "sess-2"],
    });
    expect(mocks.dispatchScheduleInDev).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      scheduleId: "heartbeat",
    });
  });

  it("URL-decodes the schedule id before dispatch", async () => {
    mocks.dispatchScheduleInDev.mockResolvedValueOnce({
      scheduleId: "weird/name",
      sessionIds: [],
    });

    const response = await postSchedule(encodeURIComponent("weird/name"));

    expect(response.status).toBe(200);
    expect(mocks.dispatchScheduleInDev).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      scheduleId: "weird/name",
    });
  });

  it("returns 404 with the list of available schedule ids when the schedule is unknown", async () => {
    const { UnknownDevScheduleError } =
      await import("#internal/nitro/host/dispatch-schedule-in-dev.js");
    mocks.dispatchScheduleInDev.mockRejectedValueOnce(
      new UnknownDevScheduleError("does-not-exist", ["heartbeat", "relay"]),
    );

    const response = await postSchedule("does-not-exist");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; availableScheduleIds: string[] };
    expect(body.availableScheduleIds).toEqual(["heartbeat", "relay"]);
    expect(body.error).toMatch(/Unknown schedule "does-not-exist"/);
  });

  it("propagates unexpected errors so Nitro can render a 500", async () => {
    mocks.dispatchScheduleInDev.mockRejectedValueOnce(new Error("kaboom"));

    await expect(postSchedule("heartbeat")).rejects.toThrow(/kaboom/);
  });
});
