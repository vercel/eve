import { describe, expect, it } from "vitest";

import { closestName } from "#shared/closest-name.js";

describe("closestName", () => {
  it.each([
    ["tool", ["tools", "skills", "subagents"], "tools"],
    ["subagent", ["tools", "skills", "subagents"], "subagents"],
    ["reseacher", ["researcher", "agent"], "researcher"],
    ["Tools", ["tools"], "tools"],
    ["agents", ["agent", "instructions"], "agent"],
  ])("suggests %s → %s", (name, candidates, expected) => {
    expect(closestName(name, candidates)).toBe(expected);
  });

  it("returns undefined when nothing is close", () => {
    expect(closestName("docs", ["tools", "skills"])).toBeUndefined();
    expect(closestName("lib", ["lib"])).toBeUndefined();
  });
});
