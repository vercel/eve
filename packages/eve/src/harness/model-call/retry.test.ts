import { describe, expect, it, vi } from "vitest";

import { ALLOW_RETRY, runModelCallWithRetries, STOP_RETRY } from "./retry.js";

const session = { sessionId: "session-alice", turnId: "turn-1" };
const busy = () => Object.assign(new Error("The provider is busy."), { isRetryable: true });

describe("runModelCallWithRetries", () => {
  it("doesn't retry a failure eve's policies stop, whatever another policy allows", async () => {
    const call = vi.fn(async () => {
      throw new Error("The request is malformed.");
    });

    await expect(
      runModelCallWithRetries(call, { ...session, policies: [() => ALLOW_RETRY] }),
    ).rejects.toThrow("malformed");
    expect(call).toHaveBeenCalledOnce();
  });

  it("stops retrying a transient failure when a policy stops it", async () => {
    const call = vi.fn(async () => {
      throw busy();
    });
    const onRetry = vi.fn(async () => {});

    await expect(
      runModelCallWithRetries(call, { ...session, onRetry, policies: [() => STOP_RETRY] }),
    ).rejects.toThrow("busy");
    expect(call).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });
});
