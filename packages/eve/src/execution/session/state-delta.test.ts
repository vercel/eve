import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { applyValueDelta, captureValue, createValueDelta } from "./state-delta.js";

function roundTrip(before: unknown, after: unknown) {
  const delta = createValueDelta(captureValue(before), after);
  return applyValueDelta(before, structuredClone(delta));
}

describe("session value deltas", () => {
  it("replaces only the shared ancestor of aliased state without repeating history", () => {
    const usage = { tokens: 1 };
    const before = { history: ["retained-history"], state: { usage, reported: usage } };
    const nextUsage = { tokens: 2 };
    const after = { ...before, state: { usage: nextUsage, reported: nextUsage } };
    const delta = createValueDelta(captureValue(before), after);
    expect(JSON.stringify(delta)).not.toContain("retained-history");
    const restored = applyValueDelta(before, structuredClone(delta)) as typeof after;
    expect(restored).toEqual(after);
    expect(restored.state.usage).toBe(restored.state.reported);
  });
  it("applies patches to records returned from a different Workflow realm", () => {
    const before = runInNewContext("({ nested: { count: 0 } })");
    const delta = createValueDelta(captureValue({ nested: { count: 0 } }), {
      nested: { count: 1 },
    });
    expect(applyValueDelta(before, delta)).toEqual({ nested: { count: 1 } });
  });
  it("captures nested mutations, removed keys, explicit undefined, and history edits", () => {
    const before = {
      history: [{ role: "user", content: "Hello" }],
      state: { count: 0, old: true },
    };
    const original = structuredClone(before);
    const captured = captureValue(before);
    before.history[0]!.content = "Edited";
    before.history.push({ role: "assistant", content: "Hi" });
    const after = { ...before, state: { count: 1, unset: undefined } };
    const delta = createValueDelta(captured, after);
    expect(applyValueDelta(original, structuredClone(delta))).toEqual(after);
    expect(original.history).toHaveLength(1);
    expect(original.state).toEqual({ count: 0, old: true });
    expect(Object.hasOwn(roundTrip({}, { unset: undefined }) as object, "unset")).toBe(true);
  });

  it.each([
    [[], [1, 2]],
    [[1, 2, 3], []],
    [
      [1, 2, 3],
      ["summary", 3],
    ],
    [
      [1, 2, 3],
      [1, 4, 3],
    ],
    [[1, 2, 3], [1]],
    [[1, 2], sparse(4)],
    [sparse(3), [undefined, 2]],
    [{ nested: { old: true } }, { nested: null }],
    [{ nested: null }, { nested: { new: true } }],
  ])("restores array and value replacements %#", (before, after) => {
    expect(roundTrip(before, after)).toEqual(after);
  });

  it("stores only appended elements for growing histories and authored state", () => {
    const retained = Array.from({ length: 100 }, (_, index) => ({ text: `retained-${index}` }));
    const before = { history: retained, state: { log: structuredClone(retained) } };
    const after = {
      history: [...retained, { text: "new-message" }],
      state: { log: [...structuredClone(retained), { text: "new-state" }] },
    };
    const delta = createValueDelta(captureValue(before), after);
    expect(JSON.stringify(delta)).not.toContain("retained-");
    expect(roundTrip(before, after)).toEqual(after);
    expect(createValueDelta(captureValue(after), structuredClone(after))).toEqual({ kind: "keep" });
  });

  it("keeps rich values on the existing serializer path even when mutated in place", () => {
    const before = {
      date: new Date(0),
      bytes: new Uint8Array([1]),
      url: new URL("https://eve.dev"),
    };
    const captured = captureValue(before);
    before.date.setTime(100);
    before.bytes[0] = 2;
    before.url.pathname = "/docs";
    const delta = createValueDelta(captured, before);
    const result = applyValueDelta({}, { kind: "replace", value: before });
    expect(applyValueDelta(before, delta)).toEqual(result);
    expect(JSON.stringify(delta)).toContain('"kind":"replace"');
  });

  it("retains cycles and aliases as whole values", () => {
    const shared: Record<string, unknown> = {};
    shared.self = shared;
    const after = { first: shared, second: shared };
    const delta = createValueDelta(captureValue({}), after);
    expect(delta.kind).toBe("replace");
    const result = roundTrip({}, after) as typeof after;
    expect(result.first).toBe(result.second);
    expect(result.first.self).toBe(result.first);
    expect(roundTrip(after, {})).toEqual({});
  });

  it("treats prototype-looking keys as own data without polluting prototypes", () => {
    const before = JSON.parse('{"__proto__":{"safe":true},"constructor":"old"}');
    const after = JSON.parse('{"__proto__":{"safe":false},"constructor":"new"}');
    const result = roundTrip(before, after);
    expect(result).toEqual(after);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
    expect(Object.hasOwn({}, "safe")).toBe(false);
  });

  it("rejects array patches applied to the wrong checkpoint", () => {
    const delta = createValueDelta(captureValue([1]), [1, 2]);
    expect(() => applyValueDelta([], delta)).toThrow("does not match");
  });
});

function sparse(length: number): unknown[] {
  const array: unknown[] = [];
  array.length = length;
  return array;
}
