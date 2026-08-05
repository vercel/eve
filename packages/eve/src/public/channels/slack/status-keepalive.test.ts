import { afterEach, describe, expect, it, vi } from "vitest";

import {
  setSlackStatusKeepaliveTestSeams,
  startSlackStatusKeepalive,
  stopSlackStatusKeepalive,
} from "#public/channels/slack/status-keepalive.js";

describe("Slack status keepalive", () => {
  afterEach(() => {
    setSlackStatusKeepaliveTestSeams();
  });

  it("refreshes the latest status", async () => {
    const sleepers: Array<() => void> = [];
    const refresh = vi.fn(async () => {});
    setSlackStatusKeepaliveTestSeams({
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepers.push(resolve);
        }),
    });

    startSlackStatusKeepalive({ key: "C01:1", refresh, status: "Working..." });
    startSlackStatusKeepalive({ key: "C01:1", refresh, status: "Searching..." });

    await vi.waitFor(() => expect(sleepers).toHaveLength(1));
    sleepers.shift()!();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledWith("Searching..."));
    await vi.waitFor(() => expect(sleepers).toHaveLength(1));
    sleepers.shift()!();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("transfers active ownership to a durable wait", async () => {
    const sleepers: Array<() => void> = [];
    const refresh = vi.fn(async () => {});
    setSlackStatusKeepaliveTestSeams({
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepers.push(resolve);
        }),
    });

    startSlackStatusKeepalive({
      key: "C01:1",
      refresh,
      status: "Working...",
    });
    await vi.waitFor(() => expect(sleepers).toHaveLength(1));
    stopSlackStatusKeepalive("C01:1");
    sleepers.shift()!();
    await Promise.resolve();

    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not let a stopped keepalive refresh", async () => {
    const sleepers: Array<() => void> = [];
    const refresh = vi.fn(async () => {});
    setSlackStatusKeepaliveTestSeams({
      sleep: () =>
        new Promise<void>((resolve) => {
          sleepers.push(resolve);
        }),
    });

    startSlackStatusKeepalive({
      key: "C01:1",
      refresh,
      status: "Working...",
    });
    await vi.waitFor(() => expect(sleepers).toHaveLength(1));
    stopSlackStatusKeepalive("C01:1");
    sleepers.shift()!();
    await Promise.resolve();

    expect(refresh).not.toHaveBeenCalled();
  });
});
