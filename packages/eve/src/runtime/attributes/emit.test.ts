import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setAttributesMock = vi.fn();

vi.mock("#compiled/@workflow/core/index.js", () => ({
  experimental_setAttributes: (...args: unknown[]) => setAttributesMock(...args),
}));

const { EVE_ATTRIBUTE_VALUE_MAX_BYTES, setEveAttributes, truncateForTag } =
  await import("#runtime/attributes/emit.js");

describe("truncateForTag", () => {
  it("returns the value unchanged when it fits within the byte budget", () => {
    expect(truncateForTag("session-title", 64)).toBe("session-title");
  });

  it("treats the byte budget as bytes, not code units", () => {
    // U+1F680 (🚀) encodes to 4 UTF-8 bytes via a surrogate pair (length 2).
    const rocket = "🚀";
    const padded = `${rocket.repeat(2)}xx`;
    const truncated = truncateForTag(padded, 8);
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(8);
    expect(truncated).toBe(rocket.repeat(2));
  });

  it("never splits a surrogate pair when shrinking", () => {
    const truncated = truncateForTag("ab🚀cd", 5);
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(5);
    expect(truncated).toBe("ab");
  });

  it("defaults to EVE_ATTRIBUTE_VALUE_MAX_BYTES when no limit is supplied", () => {
    const value = "x".repeat(EVE_ATTRIBUTE_VALUE_MAX_BYTES + 50);
    const truncated = truncateForTag(value);
    expect(truncated.length).toBe(EVE_ATTRIBUTE_VALUE_MAX_BYTES);
  });

  it("returns an empty string when the budget is zero or negative", () => {
    expect(truncateForTag("hello", 0)).toBe("");
    expect(truncateForTag("hello", -3)).toBe("");
  });
});

describe("setEveAttributes", () => {
  beforeEach(() => {
    setAttributesMock.mockReset();
    setAttributesMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards normalized attributes with allowReservedAttributes opt-in", async () => {
    await setEveAttributes({ "$eve.parent": "wrun_parent", "$eve.tool_count": 3 });

    expect(setAttributesMock).toHaveBeenCalledTimes(1);
    expect(setAttributesMock).toHaveBeenCalledWith(
      { "$eve.parent": "wrun_parent", "$eve.tool_count": "3" },
      { allowReservedAttributes: true },
    );
  });

  it("drops undefined values so callers can build sparse attribute maps", async () => {
    await setEveAttributes({
      "$eve.parent": "wrun_parent",
      "$eve.subagent": undefined,
    });

    expect(setAttributesMock).toHaveBeenCalledWith(
      { "$eve.parent": "wrun_parent" },
      { allowReservedAttributes: true },
    );
  });

  it("skips the runtime call entirely when every value is undefined", async () => {
    await setEveAttributes({ "$eve.subagent": undefined });
    expect(setAttributesMock).not.toHaveBeenCalled();
  });

  it("truncates long string values to the per-attribute byte budget", async () => {
    const longTitle = "x".repeat(EVE_ATTRIBUTE_VALUE_MAX_BYTES + 10);
    await setEveAttributes({ "$eve.title": longTitle });

    expect(setAttributesMock).toHaveBeenCalledTimes(1);
    const [payload] = setAttributesMock.mock.calls[0]!;
    expect(payload["$eve.title"].length).toBe(EVE_ATTRIBUTE_VALUE_MAX_BYTES);
  });

  it("swallows runtime errors and only warns once per process", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setAttributesMock.mockRejectedValue(new Error("world adapter unhappy"));

    await setEveAttributes({ "$eve.parent": "wrun_parent" });
    await setEveAttributes({ "$eve.parent": "wrun_parent" });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/setEveAttributes failed/);
  });
});
