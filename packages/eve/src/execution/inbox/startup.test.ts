import { afterEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { awaitInboxClaim } from "#execution/inbox/startup.js";

afterEach(() => vi.useRealTimers());

describe("startup delivery", () => {
  it("sends immediately and retries only a definite missing hook", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new HookNotFoundError("starting"))
      .mockResolvedValue({ runId: "owner" });
    const result = awaitInboxClaim(send);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toEqual({ runId: "owner" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not resend an ambiguous delivery failure", async () => {
    const error = new Error("Wake response was lost");
    const send = vi.fn().mockRejectedValue(error);
    await expect(awaitInboxClaim(send)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("bounds the bootstrap wait", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new HookNotFoundError("missing"));
    const result = expect(awaitInboxClaim(send)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(11_000);
    await result;
    expect(send.mock.calls.length).toBeLessThan(30);
  });
});
