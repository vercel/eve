import { beforeEach, describe, expect, it, vi } from "vitest";

const resumeHookMock = vi.fn();
vi.mock("#internal/workflow/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

import { handleProgressRequest } from "#runtime/progress-route.js";

const token = "abcdefghijklmnopqrstuvwxyz123456";
const context = {
  params: { token },
  requestIp: null,
  waitUntil: vi.fn(),
} as Parameters<typeof handleProgressRequest>[1];

describe("progress route", () => {
  beforeEach(() => {
    resumeHookMock.mockReset();
    resumeHookMock.mockResolvedValue(undefined);
  });

  it("accepts a valid batch through the collector hook", async () => {
    const batch = {
      events: [
        {
          eventId: "work:started",
          kind: "work.started",
          startedAt: "now",
          work: {
            id: "work",
            kind: "root-turn",
            rootSessionId: "session",
            rootTurnId: "turn",
          },
        },
      ],
      version: 1,
    };
    const response = await handleProgressRequest(
      new Request(`https://example.com/eve/v1/progress/${token}`, {
        body: JSON.stringify(batch),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(202);
    expect(resumeHookMock).toHaveBeenCalledWith(token, batch);
  });

  it("rejects malformed known events before resuming", async () => {
    const response = await handleProgressRequest(
      new Request(`https://example.com/eve/v1/progress/${token}`, {
        body: JSON.stringify({
          events: [{ eventId: "work:started", kind: "work.started" }],
          version: 1,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("returns not found when collector ownership ended", async () => {
    resumeHookMock.mockRejectedValue(new Error("missing"));
    const response = await handleProgressRequest(
      new Request(`https://example.com/eve/v1/progress/${token}`, {
        body: JSON.stringify({ events: [], version: 1 }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context,
    );
    expect(response.status).toBe(404);
  });
});
