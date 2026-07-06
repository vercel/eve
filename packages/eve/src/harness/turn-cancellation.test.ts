import { describe, expect, it } from "vitest";

import {
  isTurnCancellation,
  throwIfTurnAborted,
  TurnCancelledError,
} from "#harness/turn-cancellation.js";

describe("TurnCancelledError", () => {
  it("carries the stable name and a default message", () => {
    const error = new TurnCancelledError();
    expect(error.name).toBe("TurnCancelledError");
    expect(error.message).toBe("The turn was cancelled.");
    expect(error.cause).toBeUndefined();
  });
});

describe("isTurnCancellation", () => {
  it("matches the canonical error and name-preserving copies", () => {
    expect(isTurnCancellation(new TurnCancelledError())).toBe(true);

    const copy = Object.assign(new Error("The turn was cancelled."), {
      name: "TurnCancelledError",
    });
    expect(isTurnCancellation(copy)).toBe(true);
    expect(isTurnCancellation({ name: "TurnCancelledError" })).toBe(true);
  });

  it("walks the cause chain", () => {
    const wrapped = new Error("model call failed", { cause: new TurnCancelledError() });
    expect(isTurnCancellation(wrapped)).toBe(true);

    const deep = new Error("outer", { cause: new Error("inner", { cause: wrapped }) });
    expect(isTurnCancellation(deep)).toBe(true);
  });

  it("survives a cause cycle", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isTurnCancellation(a)).toBe(false);
  });

  it("does not match generic abort shapes", () => {
    expect(isTurnCancellation(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTurnCancellation(new DOMException("timeout", "TimeoutError"))).toBe(false);
    expect(isTurnCancellation(new Error("aborted"))).toBe(false);
    expect(isTurnCancellation(undefined)).toBe(false);
    expect(isTurnCancellation("TurnCancelledError")).toBe(false);
  });
});

describe("throwIfTurnAborted", () => {
  it("is a no-op for a missing or live signal", () => {
    expect(() => throwIfTurnAborted(undefined)).not.toThrow();
    expect(() => throwIfTurnAborted(new AbortController().signal)).not.toThrow();
  });

  it("rethrows a cancellation reason as-is", () => {
    const reason = new TurnCancelledError();
    const controller = new AbortController();
    controller.abort(reason);

    expect(() => throwIfTurnAborted(controller.signal)).toThrow(reason);
    try {
      throwIfTurnAborted(controller.signal);
    } catch (error) {
      expect(error).toBe(reason);
    }
  });

  it("normalizes non-cancellation reasons to the canonical error", () => {
    const bare = new AbortController();
    bare.abort();
    expect(() => throwIfTurnAborted(bare.signal)).toThrow(TurnCancelledError);

    const custom = new AbortController();
    custom.abort(new Error("stop it"));
    expect(() => throwIfTurnAborted(custom.signal)).toThrow(TurnCancelledError);
  });
});
