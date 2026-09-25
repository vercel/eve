import { afterEach, describe, expect, it, vi } from "vitest";

import { submitActivity } from "#execution/submit-activity.js";

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

describe("submitActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["http", "transport", "timeout"])(
    "logs a %s failure once at warning severity and does not fail the session",
    async (failure) => {
      vi.stubEnv("EVE_LOG_LEVEL", "warn");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = vi.fn();
      if (failure === "http") {
        fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
      } else {
        if (failure === "timeout") {
          vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
        }
        fetchMock.mockRejectedValue(new Error("activity delivery failed"));
      }
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        submitActivity({
          sink: {
            url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
            version: 1,
          },
          events: [event],
        }),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
        "[eve:execution.activity-submit] activity sink request failed",
      );
      expect(errorSpy).not.toHaveBeenCalled();
    },
  );

  it("does nothing without a sink", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(submitActivity({ sink: undefined, events: [event] })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts one versioned batch and swallows transport failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockRejectedValueOnce(new Error("network failure"));
    vi.stubGlobal("fetch", fetchMock);
    const sink = {
      url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
      version: 1 as const,
    };
    await submitActivity({ sink, events: [event] });
    await expect(submitActivity({ sink, events: [event] })).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      events: [event],
      version: 1,
    });
  });
});
