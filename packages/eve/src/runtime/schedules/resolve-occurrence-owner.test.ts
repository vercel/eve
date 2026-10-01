import { expect, it, vi } from "vitest";

import type { Runtime } from "#channel/types.js";
import { OccurrenceAdmissionPendingError } from "#shared/occurrence-admission-errors.js";
import {
  CreateOnceClaimPendingError,
  resolveCreateOnceOwner,
} from "#runtime/schedules/resolve-occurrence-owner.js";

it("waits for the admitted owner and refuses to report an unsettled claim", async () => {
  const runtime: Runtime = {
    createSession: vi.fn(),
    dispatchContinuation: vi.fn(),
    dispatchSession: vi.fn(),
    getEventStream: vi.fn(),
    getStreamTailIndex: vi.fn(),
    resolveContinuation: vi
      .fn<Runtime["resolveContinuation"]>()
      .mockRejectedValueOnce(new OccurrenceAdmissionPendingError())
      .mockResolvedValueOnce({ sessionId: "winner" }),
  };
  vi.useFakeTimers();
  try {
    const owner = resolveCreateOnceOwner(runtime, "occurrence", { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(owner).resolves.toBe("winner");

    vi.mocked(runtime.resolveContinuation).mockResolvedValue(undefined);
    const pending = expect(
      resolveCreateOnceOwner(runtime, "occurrence", { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(CreateOnceClaimPendingError);
    await vi.advanceTimersByTimeAsync(100);
    await pending;
  } finally {
    vi.useRealTimers();
  }
});
