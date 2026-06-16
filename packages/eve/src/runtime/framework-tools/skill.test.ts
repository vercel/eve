import { describe, expect, it } from "vitest";

import { SKILL_TOOL_DEFINITION } from "#runtime/framework-tools/skill.js";

describe("SKILL_TOOL_DEFINITION", () => {
  it("describes when skill loading should be used", () => {
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "request clearly matches a listed skill description",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain(
      "Loading adds the skill instructions to the current turn.",
    );
    expect(SKILL_TOOL_DEFINITION.description).toContain("Available skills block");
  });
});
