import { describe, expect, it } from "vitest";

import {
  formatValuePretty,
  summarizeToolArgs,
  summarizeToolResult,
  truncate,
} from "./tool-format.js";

describe("summarizeToolArgs", () => {
  it("renders shallow objects as key=value", () => {
    expect(summarizeToolArgs({ city: "SF", units: "metric" })).toBe('city="SF" units="metric"');
  });

  it("collapses nested values to type hints", () => {
    expect(summarizeToolArgs({ filters: { a: 1 }, ids: [1, 2, 3] })).toBe("filters={…} ids=[3]");
  });

  it("returns an empty string for empty input", () => {
    expect(summarizeToolArgs({})).toBe("");
    expect(summarizeToolArgs(undefined)).toBe("");
  });

  it("strips terminal controls from keys and values", () => {
    expect(summarizeToolArgs({ "city\x1b]0;title\x07": "SF\x1bPqpayload\x1b\\" })).toBe(
      'city]0;title="SFPqpayload\\"',
    );
  });
});

describe("summarizeToolResult", () => {
  it("prefers a meaningful scalar field", () => {
    expect(summarizeToolResult({ result: "ok", extra: 1 })).toBe("ok");
  });

  it("counts array results", () => {
    expect(summarizeToolResult([1, 2])).toBe("2 items");
  });

  it("uses the first non-empty line of a string", () => {
    expect(summarizeToolResult("\n  first\nsecond")).toBe("first");
  });

  it("strips terminal controls from scalar fields", () => {
    expect(summarizeToolResult({ result: "ok\x1b]52;c;cGFzdGU=\x07" })).toBe("ok]52;c;cGFzdGU=");
  });
});

describe("formatValuePretty", () => {
  it("strips terminal controls from expanded string values", () => {
    expect(formatValuePretty("ok\x1bPqpayload\x1b\\")).toBe("okPqpayload\\");
  });

  it("strips terminal controls from expanded structured values", () => {
    expect(formatValuePretty({ text: "ok\u009d0;title\u009c" })).toBe(
      '{\n  "text": "ok0;title"\n}',
    );
  });
});

describe("truncate", () => {
  it("appends an ellipsis past the limit", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });

  it("collapses whitespace", () => {
    expect(truncate("a   b\tc", 80)).toBe("a b c");
  });
});
