import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmptyDerivedFacts } from "#evals/runner/derive-run-facts.js";
import { AssertionCollector } from "#evals/assertions/collector.js";
import { EvalRequirementFailed } from "#evals/control-flow.js";
import { requireEventually } from "#evals/eventually.js";
import { equals } from "#evals/expect/index.js";
import type { EveEvalTaskResult } from "#evals/types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("requireEventually", () => {
  it("retries until the assertion passes and records one gate", async () => {
    vi.useFakeTimers();
    const collector = new AssertionCollector();
    const sample = vi
      .fn<() => string>()
      .mockReturnValueOnce("pending")
      .mockReturnValueOnce("pending")
      .mockReturnValue("ready");

    const pending = requireEventually({
      assertion: equals("ready"),
      collector,
      options: { intervalMs: 100, timeoutMs: 500 },
      sample,
      signal: new AbortController().signal,
    });

    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toBe("ready");
    expect(sample).toHaveBeenCalledTimes(3);
    await expect(collector.finalize(emptyResult())).resolves.toEqual([
      expect.objectContaining({
        name: "eventually(equals)",
        passed: true,
        score: 1,
        severity: "gate",
      }),
    ]);
  });

  it("records one failed gate when the retry window ends", async () => {
    vi.useFakeTimers();
    const collector = new AssertionCollector();
    const sample = vi.fn(() => "pending");
    const pending = requireEventually({
      assertion: equals("ready"),
      collector,
      options: { intervalMs: 100, timeoutMs: 250 },
      sample,
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(EvalRequirementFailed);

    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(sample).toHaveBeenCalledTimes(4);

    const assertions = await collector.finalize(emptyResult());
    expect(assertions).toEqual([
      expect.objectContaining({
        message: "condition did not pass within 250ms after 4 attempt(s)",
        name: "eventually(equals)",
        passed: false,
        score: 0,
        severity: "gate",
      }),
    ]);
  });

  it("propagates callback errors without retrying", async () => {
    const collector = new AssertionCollector();
    const error = new Error("read failed");
    const sample = vi.fn(() => {
      throw error;
    });

    await expect(
      requireEventually({
        assertion: equals("ready"),
        collector,
        sample,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(error);
    expect(sample).toHaveBeenCalledTimes(1);
    await expect(collector.finalize(emptyResult())).resolves.toEqual([]);
  });

  it("stops a pending retry when the eval signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("eval timed out");
    const pending = requireEventually({
      assertion: equals("ready"),
      collector: new AssertionCollector(),
      options: { intervalMs: 1_000, timeoutMs: 5_000 },
      sample: () => "pending",
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("validates timing options", async () => {
    const base = {
      assertion: equals("ready"),
      collector: new AssertionCollector(),
      sample: () => "ready",
      signal: new AbortController().signal,
    };

    await expect(requireEventually({ ...base, options: { intervalMs: 0 } })).rejects.toThrow(
      /intervalMs/,
    );
    await expect(
      requireEventually({ ...base, options: { timeoutMs: Number.NaN } }),
    ).rejects.toThrow(/timeoutMs/);
  });
});

function emptyResult(): EveEvalTaskResult {
  return {
    derived: createEmptyDerivedFacts(),
    events: [],
    finalMessage: null,
    output: null,
    status: "completed",
  };
}
