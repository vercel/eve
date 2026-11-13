import { describe, expect, it } from "vitest";
import { isRetriedStep, registerHost } from "#execution/hosts.js";
import { NonRetryableError } from "#shared/run-errors.js";
import { createStepAttempts, type StepFaults } from "./step-attempts.js";

/** Runs a step through `faults`, recording each attempt and what it reads as it enters. */
async function runStep(
  faults: StepFaults | undefined,
  /** What attempt `attempt` throws, if anything. */
  throws: (attempt: number) => unknown = () => undefined,
) {
  const attempts = createStepAttempts(faults);
  const release = registerHost({
    deliver: async () => undefined,
    runEnded: () => undefined,
    cancelRun: () => undefined,
    stepAttempt: () => attempts.current(),
  });
  const seen: { readonly attempt: number; readonly retried: boolean }[] = [];
  try {
    const result = await attempts.run(
      { name: "turnStep", sessionId: "session-alice" },
      async ({ attempt }) => attempt,
      async (attempt) => {
        seen.push({ attempt, retried: isRetriedStep() });
        const thrown = throws(attempt);
        if (thrown !== undefined) throw thrown;
        return `attempt ${attempt}`;
      },
    );
    return { result, seen };
  } finally {
    release();
  }
}

describe("in-process step attempts", () => {
  it("runs a step once, as its first attempt, without faults", async () => {
    expect(await runStep(undefined)).toEqual({
      result: "attempt 1",
      seen: [{ attempt: 1, retried: false }],
    });
  });

  it("runs a step whose completion was lost again, as a retry", async () => {
    const { result, seen } = await runStep({ loseCompletion: ({ attempt }) => attempt === 1 });
    expect(result).toBe("attempt 2");
    expect(seen).toEqual([
      { attempt: 1, retried: false },
      { attempt: 2, retried: true },
    ]);
  });

  it("fails a step past its retry limit without running it, as Workflow does", async () => {
    const error = await runStep({ loseCompletion: () => true, maxRetries: 1 }).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      fatal: true,
      message: 'Step "turnStep" exceeded max retries (1 retry)',
      name: "FatalError",
    });
  });

  it("fails a step that threw at once without faults", async () => {
    const error = new Error("The session stream is unavailable");
    await expect(runStep(undefined, () => error)).rejects.toBe(error);
  });

  it("runs a step that threw again, as a retry, after `retrying`", async () => {
    const retrying: number[] = [];
    const { result, seen } = await runStep(
      { retrying: async ({ attempt }) => void retrying.push(attempt) },
      (attempt) => (attempt === 1 ? new Error("The session stream is unavailable") : undefined),
    );
    expect(result).toBe("attempt 2");
    expect(seen.map(({ retried }) => retried)).toEqual([false, true]);
    expect(retrying).toEqual([2]);
  });

  it("fails a step that threw every attempt as Workflow does, with the last error as cause", async () => {
    const last = new Error("The session stream is unavailable");
    const error = await runStep({ maxRetries: 2 }, () => last).catch((error: unknown) => error);
    expect(error).toMatchObject({
      cause: last,
      fatal: true,
      message: 'Step "turnStep" failed after 2 retries: The session stream is unavailable',
      name: "FatalError",
    });
  });

  it("doesn't retry a step that threw a fatal error", async () => {
    const fatal = new NonRetryableError("Alice's request can't be served.");
    const tried: number[] = [];
    const thrown = (attempt: number) => {
      tried.push(attempt);
      return fatal;
    };
    await expect(runStep({}, thrown)).rejects.toBe(fatal);
    expect(tried).toEqual([1]);
  });

  it("fails every write of an attempt after the one `failWrite` picks", async () => {
    const attempts = createStepAttempts({ failWrite: (_step, chunk) => chunk[0] === 2 });
    const written: number[] = [];
    const stream = new WritableStream<Uint8Array>({
      write: (chunk) => void written.push(chunk[0]!),
    });
    const step = { attempt: 1, name: "turnStep", sessionId: "session-alice" };
    const writer = attempts.writable(step, stream).getWriter();
    await writer.write(new Uint8Array([1]));
    await expect(writer.write(new Uint8Array([2]))).rejects.toThrow("unavailable");
    await expect(writer.write(new Uint8Array([3]))).rejects.toThrow("unavailable");
    // The next attempt writes through a stream of its own.
    const retry = attempts.writable({ ...step, attempt: 2 }, stream).getWriter();
    await retry.write(new Uint8Array([4]));
    expect(written).toEqual([1, 4]);
  });

  it("names a step's attempt only while it enters", async () => {
    const attempts = createStepAttempts(undefined);
    const read = await attempts.enter(2, async () => {
      const entering = attempts.current();
      await Promise.resolve();
      return { entering, later: attempts.current() };
    });
    expect(read).toEqual({ entering: 2, later: undefined });
    expect(attempts.current()).toBeUndefined();
  });
});
