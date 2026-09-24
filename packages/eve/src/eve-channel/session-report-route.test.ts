import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { none } from "#public/channels/auth.js";
import type { RouteHandlerArgs } from "#public/definitions/channel.js";
import { eveChannel } from "#eve-channel/index.js";
import { readLatestTaskReport } from "#subagents/task-reports.js";

vi.mock("#subagents/task-reports.js", () => ({ readLatestTaskReport: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe("session report route", () => {
  it("returns the latest result a delegated session reported for one call", async () => {
    const report = { callId: "call-1", kind: "turn.completed", output: "Refund approved." };
    vi.mocked(readLatestTaskReport).mockResolvedValueOnce(report);

    const response = await fetchReport({ auth: none() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, report, taskProtocol: 1 });
    // The report is kept for its callback; only the holder of that token can read it.
    expect(readLatestTaskReport).toHaveBeenCalledExactlyOnceWith({
      callbackToken: "callback-token",
      callId: "call-1",
      sessionId: "remote-1",
    });
  });

  it("answers null for a call the session has not answered yet", async () => {
    vi.mocked(readLatestTaskReport).mockResolvedValueOnce(undefined);

    const response = await fetchReport({ auth: none() });

    await expect(response.json()).resolves.toEqual({ ok: true, report: null, taskProtocol: 1 });
  });

  it("answers a failed read like a missing report, without saying why", async () => {
    vi.mocked(readLatestTaskReport).mockRejectedValueOnce(new Error("run not found"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await fetchReport({ auth: none() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, report: null, taskProtocol: 1 });
    error.mockRestore();
  });

  it("refuses a read without the callback token the report was sent to", async () => {
    const response = await fetchReport({ auth: none() }, {});

    expect(response.status).toBe(400);
    expect(readLatestTaskReport).not.toHaveBeenCalled();
  });

  it("requires the channel's auth, like the session's stream", async () => {
    const response = await fetchReport({ auth: () => null });

    expect(response.status).toBe(401);
    expect(readLatestTaskReport).not.toHaveBeenCalled();
  });
});

async function fetchReport(
  input: Parameters<typeof eveChannel>[0],
  headers: Record<string, string> = { "x-eve-callback-token": "callback-token" },
): Promise<Response> {
  const route = eveChannel(input).routes.find(
    (candidate) =>
      candidate.method === "GET" && candidate.path === "/eve/v1/session/:sessionId/reports/:callId",
  );
  if (route === undefined) throw new Error("No report route found");
  const args: RouteHandlerArgs = {
    ...mockChannelContext(vi.fn()),
    attachSession: vi.fn(),
    params: { callId: "call-1", sessionId: "remote-1" },
    requestIp: null,
    to: vi.fn() as never,
    waitUntil() {},
  };
  return await (
    route as { handler: (req: Request, args: RouteHandlerArgs) => Promise<Response> }
  ).handler(
    new Request("https://remote.example/eve/v1/session/remote-1/reports/call-1", { headers }),
    args,
  );
}
