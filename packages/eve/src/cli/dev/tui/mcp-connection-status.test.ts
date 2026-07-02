import { afterEach, describe, expect, it, vi } from "vitest";

import { createMcpConnectionStatusTracker, probeMcpConnection } from "./mcp-connection-status.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("probeMcpConnection", () => {
  it("treats an authorization response as a reachable endpoint", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      probeMcpConnection({
        url: "https://mcp.notion.com/mcp",
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  it("reports the observed status for an unreachable endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(
      probeMcpConnection({
        url: "https://mcp.datadoghq.com/api/mcp",
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("https://mcp.datadoghq.com/api/mcp is not reachable (HTTP 404).");
  });
});

describe("createMcpConnectionStatusTracker", () => {
  it("probes at boot and refreshes the cached warning during the session", async () => {
    vi.useFakeTimers();
    const snapshots: Array<Readonly<Record<string, string>>> = [];
    let datadogAvailable = false;
    const tracker = createMcpConnectionStatusTracker({
      intervalMs: 60_000,
      onChange: (snapshot) => snapshots.push(snapshot),
      probe: async ({ url }) =>
        url === "https://mcp.datadoghq.com/api/mcp" && !datadogAvailable
          ? `${url} is not reachable (HTTP 404).`
          : undefined,
    });

    tracker.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(tracker.current()).toEqual({
      datadog: "https://mcp.datadoghq.com/api/mcp is not reachable (HTTP 404).",
    });

    datadogAvailable = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracker.current()).toEqual({});
    expect(snapshots).toHaveLength(2);

    tracker.dispose();
  });
});
