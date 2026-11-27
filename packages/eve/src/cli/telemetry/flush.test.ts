import { afterEach, describe, expect, it, vi } from "vitest";

import { flushEveCliTelemetry } from "#cli/telemetry/flush.js";
import { resolveEveTelemetryInternal } from "#cli/telemetry/internal.js";

vi.mock("#cli/telemetry/internal.js", () => ({
  resolveEveTelemetryInternal: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.mocked(resolveEveTelemetryInternal).mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

  it("adds the internal flag only when it is known", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal("fetch", fetchMock);
    const payload = JSON.stringify({
      sessionId: "session_123",
      events: [{ id: "event_123", event_time: 1, key: "command", value: "info" }],
    });
    const sentEvents = () =>
      JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body)) as Array<{
        key: string;
        value: string;
      }>;

    await flushEveCliTelemetry(payload);
    expect(sentEvents()).not.toContainEqual(expect.objectContaining({ key: "internal" }));

    vi.mocked(resolveEveTelemetryInternal).mockResolvedValue(false);
    await flushEveCliTelemetry(payload);
    expect(sentEvents()).toContainEqual(
      expect.objectContaining({ key: "internal", value: "false" }),
    );
  });

  it("ignores an invalid payload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushEveCliTelemetry("not json");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
