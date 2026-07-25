import { describe, expect, it } from "vitest";

import { disableSubagent, isDisabledSubagentSentinel } from "#public/definitions/subagent.js";

describe("disableSubagent", () => {
  it("returns a recognizable disabled subagent sentinel", () => {
    const sentinel = disableSubagent();

    expect(sentinel).toEqual({ kind: "eve:disabled-subagent" });
    expect(isDisabledSubagentSentinel(sentinel)).toBe(true);
    expect(isDisabledSubagentSentinel({ kind: "remote" })).toBe(false);
  });
});
