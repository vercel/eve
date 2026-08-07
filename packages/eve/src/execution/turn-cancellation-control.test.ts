import { afterEach, describe, expect, it, vi } from "vitest";

import { createTurnCancellationControl } from "#execution/turn-cancellation-control.js";
import { turnCancellationHookToken } from "#execution/turn-cancellation-token.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

const createHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: (...args: unknown[]) => createHookMock(...args),
}));

function installCancelHook(options: {
  readonly conflict?: { readonly runId: string } | null;
  readonly payloads?: readonly unknown[];
}): { dispose: ReturnType<typeof vi.fn> } {
  const queue = [...(options.payloads ?? [])];
  const dispose = vi.fn();
  createHookMock.mockReturnValue({
    token: "session-1:cancel",
    getConflict: vi.fn(async () => options.conflict ?? null),
    dispose,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: () => {
          const value = queue.shift();
          return value === undefined
            ? new Promise<IteratorResult<unknown>>(() => {})
            : Promise.resolve({ done: false, value });
        },
        return: vi.fn(async () => ({ done: true, value: undefined })),
      };
    },
  });
  return { dispose };
}

async function settles(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
}

describe("turnCancellationHookToken", () => {
  it("derives a private token from the turn control token", () => {
    expect(turnCancellationHookToken("wrun_abc:turn-control:1")).toBe(
      "wrun_abc:turn-control:1:cancel",
    );
  });
});

describe("createTurnCancellationControl", () => {
  afterEach(() => {
    createHookMock.mockReset();
  });

  it("returns undefined when the token is claimed by another run", async () => {
    installCancelHook({ conflict: { runId: "wrun_stale" } });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_0",
    });

    expect(control).toBeUndefined();
  });

  it("aborts the turn signal on a cancel without a turn guard", async () => {
    installCancelHook({ payloads: [{}] });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_0",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
    expect(control!.signal.reason).toBeInstanceOf(TurnCancelledError);
  });

  it("aborts on a cancel whose guard matches the active turn", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_2" }] });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_2",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
  });

  it("consumes a stale turn guard as a no-op and honors the next matching cancel", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_99" }, { turnId: "turn_2" }] });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_2",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
  });

  it("never aborts when only mismatched guards arrive", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_99" }] });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_2",
    });

    expect(await settles(control!.requested)).toBe(false);
    expect(control!.signal.aborted).toBe(false);
  });

  it("flips the signal in the same microtask that consumes the payload", async () => {
    // A wake replays a journaled cancel and a completed step in one drain,
    // payload first; the settle check reads `signal.aborted` one microtask
    // later, so a `.then`-chained abort would lose to it.
    let releasePayload!: (result: IteratorResult<unknown>) => void;
    const firstRead = new Promise<IteratorResult<unknown>>((resolve) => {
      releasePayload = resolve;
    });
    let delivered = false;
    createHookMock.mockReturnValue({
      token: "session-1:cancel",
      getConflict: vi.fn(async () => null),
      dispose: vi.fn(),
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          next: () => {
            if (delivered) return new Promise<IteratorResult<unknown>>(() => {});
            delivered = true;
            return firstRead;
          },
          return: vi.fn(async () => ({ done: true, value: undefined })),
        };
      },
    });

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_0",
    });

    let releaseStep!: () => void;
    const step = new Promise<void>((resolve) => {
      releaseStep = resolve;
    });
    const abortedAtStepContinuation = step.then(() => control!.signal.aborted);

    // Journal order: the cancel payload resolves before the step result.
    releasePayload({ done: false, value: {} });
    releaseStep();

    await expect(abortedAtStepContinuation).resolves.toBe(true);
    await expect(control!.requested).resolves.toBe("cancel");
  });

  it("disposes idempotently", async () => {
    const { dispose } = installCancelHook({});

    const control = await createTurnCancellationControl({
      controlToken: "session-1",
      expectedTurnId: "turn_0",
    });

    await control!.dispose();
    await control!.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
