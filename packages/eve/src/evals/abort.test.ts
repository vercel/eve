import { describe, expect, it } from "vitest";
import { runUntilAborted } from "#evals/abort.js";

describe("eval cancellation", () => {
  it("rejects an already-aborted signal even when the task is settled", async () => {
    const reason = new Error("Deadline reached");
    await expect(runUntilAborted(Promise.resolve(1), AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
  });

  it("observes task failures when cancellation has already occurred", async () => {
    const reason = new Error("Deadline reached");
    await expect(
      runUntilAborted(Promise.reject(new Error("Task failed")), AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
  });
});
