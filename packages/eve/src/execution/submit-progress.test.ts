import { afterEach, describe, expect, it, vi } from "vitest";

import { reportProgress } from "#execution/submit-progress.js";

const event = {
  eventId: "root:session:turn:started",
  kind: "work.started" as const,
  startedAt: "now",
  work: {
    id: "root:session:turn",
    kind: "root-turn" as const,
    rootSessionId: "session",
    rootTurnId: "turn",
  },
};

describe("reportProgress", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing without the callback capability", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(reportProgress({ callback: undefined, events: [event] })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts one versioned batch and swallows transport failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error("network failure"));
    vi.stubGlobal("fetch", fetchMock);
    const callback = {
      url: "https://agent.example.com/eve/v1/progress/abcdefghijklmnopqrstuvwxyz123456",
      version: 1 as const,
    };
    await reportProgress({ callback, events: [event] });
    await expect(reportProgress({ callback, events: [event] })).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      events: [event],
      version: 1,
    });
  });
});
