import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTurnCancellationControl,
  sessionCancelHookToken,
} from "#execution/turn-cancellation-control.js";
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

describe("sessionCancelHookToken", () => {
  it("derives the stable token from the session id", () => {
    expect(sessionCancelHookToken("wrun_abc")).toBe("wrun_abc:cancel");
  });
});

describe("createTurnCancellationControl", () => {
  afterEach(() => {
    createHookMock.mockReset();
  });

  it("returns undefined when the token is claimed by another run", async () => {
    installCancelHook({ conflict: { runId: "wrun_stale" } });

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_0",
      sessionId: "session-1",
    });

    expect(control).toBeUndefined();
  });

  it("aborts the turn signal on a cancel without a turn guard", async () => {
    installCancelHook({ payloads: [{}] });

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_0",
      sessionId: "session-1",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
    expect(control!.signal.reason).toBeInstanceOf(TurnCancelledError);
  });

  it("aborts on a cancel whose guard matches the active turn", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_2" }] });

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_2",
      sessionId: "session-1",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
  });

  it("consumes a stale turn guard as a no-op and honors the next matching cancel", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_99" }, { turnId: "turn_2" }] });

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_2",
      sessionId: "session-1",
    });

    await expect(control!.requested).resolves.toBe("cancel");
    expect(control!.signal.aborted).toBe(true);
  });

  it("never aborts when only mismatched guards arrive", async () => {
    installCancelHook({ payloads: [{ turnId: "turn_99" }] });

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_2",
      sessionId: "session-1",
    });

    expect(await settles(control!.requested)).toBe(false);
    expect(control!.signal.aborted).toBe(false);
  });

  it("disposes idempotently", async () => {
    const { dispose } = installCancelHook({});

    const control = await createTurnCancellationControl({
      expectedTurnId: "turn_0",
      sessionId: "session-1",
    });

    await control!.dispose();
    await control!.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
