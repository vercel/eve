import { describe, expect, it } from "vitest";

import { toError, toErrorMessage } from "#shared/errors.js";

describe("toErrorMessage", () => {
  it("returns the message of a real Error instance", () => {
    expect(toErrorMessage(new Error("kaboom"))).toBe("kaboom");
    expect(toErrorMessage(new TypeError("bad input"))).toBe("bad input");
  });

  it("stringifies primitives and nullish values", () => {
    expect(toErrorMessage("string throw")).toBe("string throw");
    expect(toErrorMessage(42)).toBe("42");
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("prefers the .message field on Error-shaped plain objects", () => {
    // Structured-clone across a workflow step boundary strips the Error
    // prototype but preserves fields — we must surface the original
    // message instead of collapsing to `"[object Object]"`.
    expect(toErrorMessage({ message: "upstream 429", name: "APICallError" })).toBe("upstream 429");
  });

  it("falls back to JSON for plain objects without a .message", () => {
    expect(toErrorMessage({ kind: "weird" })).toBe('{"kind":"weird"}');
  });

  it("falls back to JSON for plain objects whose .message is not a string", () => {
    expect(toErrorMessage({ message: { nested: "bad" }, code: "E_BAD" })).toBe(
      '{"message":{"nested":"bad"},"code":"E_BAD"}',
    );
  });

  it("never emits the useless '[object Object]' default", () => {
    // Guards the regression where `new Error(String(partError))`
    // surfaced `"[object Object]"` to users.
    expect(toErrorMessage({ upstream: { status: 500 } })).not.toBe("[object Object]");
  });

  it("falls back to String() when JSON.stringify throws (circular refs)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toErrorMessage(circular)).toBe("[object Object]");
  });
});

describe("toError", () => {
  it("returns Error instances unchanged", () => {
    const original = new Error("boom");
    expect(toError(original)).toBe(original);
  });

  it("preserves the TypeError / RangeError subclass identity", () => {
    const original = new TypeError("bad arg");
    expect(toError(original)).toBe(original);
    expect(toError(original)).toBeInstanceOf(TypeError);
  });

  it("rebuilds a real Error from an Error-shaped plain object", () => {
    const raw = { message: "upstream 429", name: "APICallError", stack: "fake stack" };

    const error = toError(raw);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("upstream 429");
    expect(error.name).toBe("APICallError");
    expect(error.stack).toBe("fake stack");
  });

  it("preserves the cause field when present on a plain-object throwable", () => {
    const cause = new Error("root");
    const error = toError({ message: "wrapped", cause });

    expect((error as Error & { cause?: unknown }).cause).toBe(cause);
  });

  it("drops a self-referential cause to avoid cycles", () => {
    const raw: Record<string, unknown> = { message: "loop" };
    raw.cause = raw;

    const error = toError(raw);

    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("produces a readable message for plain objects without .message", () => {
    // Regression guard for the `[object Object]` user-visible surface.
    const error = toError({ statusCode: 500, body: "upstream exploded" });

    expect(error.message).toBe('{"statusCode":500,"body":"upstream exploded"}');
    expect(error.message).not.toBe("[object Object]");
  });

  it("wraps primitives in Errors carrying the stringified value", () => {
    expect(toError("string throw").message).toBe("string throw");
    expect(toError(42).message).toBe("42");
    expect(toError(null).message).toBe("null");
    expect(toError(undefined).message).toBe("undefined");
  });
});
