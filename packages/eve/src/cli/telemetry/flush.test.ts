import { describe, expect, it, vi } from "vitest";

import { flushEveCliTelemetry } from "#cli/telemetry/flush.js";

describe("flushEveCliTelemetry", () => {
  it("posts a valid batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("EVE_TELEMETRY_ENDPOINT", "http://localhost/events");

    await flushEveCliTelemetry(
      JSON.stringify({
        sessionId: "session_123",
        events: [{ id: "event_123", event_time: 1, key: "command", value: "info" }],
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost/events",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-eve-cli-session-id": "session_123" }),
      }),
    );
  });

  it("ignores an invalid payload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushEveCliTelemetry("not json");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
