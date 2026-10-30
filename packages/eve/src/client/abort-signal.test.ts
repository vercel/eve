import { describe, expect, it, vi } from "vitest";

import { throwIfAborted } from "#client/abort-signal.js";

describe("throwIfAborted", () => {
  it("does nothing for an active signal without a native implementation", () => {
    expect(() => throwIfAborted({ aborted: false } as AbortSignal)).not.toThrow();
  });

  it("uses a native implementation when present", () => {
    const nativeThrowIfAborted = vi.fn();
    const signal = Object.assign(new AbortController().signal, {
      throwIfAborted: nativeThrowIfAborted,
    });

    throwIfAborted(signal);

    expect(nativeThrowIfAborted).toHaveBeenCalledOnce();
  });

  it("throws the abort reason when an aborted signal has no native implementation", () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });

    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it("creates an AbortError when an aborted signal has neither implementation nor reason", () => {
    expect(() => throwIfAborted({ aborted: true } as AbortSignal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });
});
