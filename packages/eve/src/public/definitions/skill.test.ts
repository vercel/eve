import { describe, expect, it } from "vitest";

import { defineSkill } from "#public/definitions/skill.js";

describe("defineSkill", () => {
  it("accepts TypeScript-authored skill packages with sibling files", () => {
    const skill = defineSkill({
      description: "Research unfamiliar topics.",
      markdown: "Use primary sources.",
      files: {
        "assets/query.bin": new Uint8Array([1, 2, 3]),
        "references/checklist.md": "# Checklist\n",
      },
    });

    expect(skill.files?.["references/checklist.md"]).toBe("# Checklist\n");
  });
});
