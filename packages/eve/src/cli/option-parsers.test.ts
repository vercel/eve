import { describe, expect, it } from "vitest";

import { parseSubagentDisplayMode } from "#cli/option-parsers.js";

describe("parseSubagentDisplayMode", () => {
  it("accepts the subagent modes and names them when rejecting another", () => {
    expect(["full", "collapsed", "hidden"].map(parseSubagentDisplayMode)).toEqual([
      "full",
      "collapsed",
      "hidden",
    ]);
    // `auto-collapsed` was removed: it never differed from `collapsed`.
    expect(() => parseSubagentDisplayMode("auto-collapsed")).toThrow(
      'Expected one of full, collapsed, hidden, received "auto-collapsed".',
    );
  });
});
