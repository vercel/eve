import { describe, expect, it, vi } from "vitest";

import { type AnySetupBox, RetryableSetupError, runHeadless, runInteractive } from "./runner.js";
import { WizardCancelledError, type OutputSink, type SetupBox } from "./step.js";

interface TestState {
  log: string[];
}

const silentSink: OutputSink = { write: () => {} };

function box(
  id: string,
  overrides: Partial<SetupBox<TestState, string, string>> = {},
): SetupBox<TestState, string, string> {
  return {
    id,
    async gather() {
      return id;
    },
    async perform({ input }) {
      return `did:${input}`;
    },
    apply(state, payload) {
      return { log: [...state.log, payload] };
    },
    ...overrides,
  };
}

describe("runInteractive", () => {
  it("threads state through gather -> perform -> apply for each box", async () => {
    const result = await runInteractive([box("a"), box("b")], { log: [] }, silentSink);
    expect(result).toEqual({ kind: "done", state: { log: ["did:a", "did:b"] } });
  });

  it("stops the whole run on cancel without applying", async () => {
    const second = box("b");
    const performSpy = vi.spyOn(second, "perform");
    const cancelling = box("a", {
      async gather() {
        throw new WizardCancelledError();
      },
    });

    const result = await runInteractive([cancelling, second], { log: [] }, silentSink);

    expect(result).toEqual({ kind: "cancelled" });
    expect(performSpy).not.toHaveBeenCalled();
  });

  it("waits for an aborted perform to unwind without applying its payload", async () => {
    const controller = new AbortController();
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const apply = vi.fn((state: TestState, payload: string) => ({
      log: [...state.log, payload],
    }));
    const cancellable = box("a", {
      async perform({ signal }) {
        markStarted();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return "must-not-apply";
      },
      apply,
    });

    const result = runInteractive([cancellable], { log: [] }, silentSink, {
      signal: controller.signal,
    });
    await started;
    controller.abort(new WizardCancelledError());

    await expect(result).resolves.toEqual({ kind: "cancelled" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("re-gathers and retries when perform throws a RetryableSetupError", async () => {
    let attempts = 0;
    const gather = vi.fn(async () => "x");
    const flaky = box("flaky", {
      gather,
      async perform() {
        attempts += 1;
        if (attempts === 1) throw new RetryableSetupError("transient");
        return "recovered";
      },
    });

    const result = await runInteractive([flaky], { log: [] }, silentSink);

    expect(attempts).toBe(2);
    expect(gather).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ kind: "done", state: { log: ["recovered"] } });
  });

  it("propagates a non-retryable error", async () => {
    const boom = box("boom", {
      async perform() {
        throw new Error("fatal");
      },
    });
    await expect(runInteractive([boom], { log: [] }, silentSink)).rejects.toThrow("fatal");
  });

  it("skips a box whose shouldRun returns false", async () => {
    const skipped = box("skip", { shouldRun: () => false });
    const performSpy = vi.spyOn(skipped, "perform");

    const result = await runInteractive([skipped, box("b")], { log: [] }, silentSink);

    expect(performSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: "done", state: { log: ["did:b"] } });
  });
});

describe("runHeadless", () => {
  it("derives input from presets and applies each box", async () => {
    const boxes: AnySetupBox<TestState>[] = [box("a"), box("b")];
    const state = await runHeadless(boxes, { log: [] }, silentSink);
    expect(state).toEqual({ log: ["did:a", "did:b"] });
  });

  it("respects shouldRun", async () => {
    const boxes: AnySetupBox<TestState>[] = [box("a", { shouldRun: () => false }), box("b")];
    const state = await runHeadless(boxes, { log: [] }, silentSink);
    expect(state).toEqual({ log: ["did:b"] });
  });
});

// The single-gather shape (see step.ts): both runners call the same gather, so
// the runner-level differences shrink to cancel folding and the retry loop.
describe("unified boxes", () => {
  it("runs one gather face through both runners", async () => {
    const interactive = await runInteractive([box("u"), box("legacy")], { log: [] }, silentSink);
    expect(interactive).toEqual({ kind: "done", state: { log: ["did:u", "did:legacy"] } });

    const headless = await runHeadless([box("u"), box("legacy")], { log: [] }, silentSink);
    expect(headless).toEqual({ log: ["did:u", "did:legacy"] });
  });

  it("folds a WizardCancelledError thrown by gather into a cancelled run", async () => {
    const second = box("after");
    const performSpy = vi.spyOn(second, "perform");
    const cancelling = box("u", {
      async gather() {
        throw new WizardCancelledError();
      },
    });

    const result = await runInteractive([cancelling, second], { log: [] }, silentSink);

    expect(result).toEqual({ kind: "cancelled" });
    expect(performSpy).not.toHaveBeenCalled();
  });

  it("re-gathers with the prior input on a RetryableSetupError", async () => {
    let attempts = 0;
    const gather = vi.fn(async ({ initial }: { initial?: string }) => initial ?? "first");
    const flaky = box("flaky", {
      gather,
      async perform({ input }) {
        attempts += 1;
        if (attempts === 1) throw new RetryableSetupError("transient");
        return `did:${input}`;
      },
    });

    const result = await runInteractive([flaky], { log: [] }, silentSink);

    expect(attempts).toBe(2);
    expect(gather).toHaveBeenCalledTimes(2);
    expect(gather.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ initial: "first" }));
    expect(result).toEqual({ kind: "done", state: { log: ["did:first"] } });
  });
});
