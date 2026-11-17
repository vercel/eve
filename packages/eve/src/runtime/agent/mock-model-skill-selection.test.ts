import { describe, expect, it } from "vitest";

import { dynamicSkillAnnouncements } from "#execution/skills/instructions.js";
import { getAvailableSkills } from "#runtime/agent/mock-model-skill-selection.js";

describe("getAvailableSkills", () => {
  it("reads skills from a dynamic skill announcement", () => {
    const announcement = dynamicSkillAnnouncements(
      [
        {
          deferred: false,
          description: "Billing rules.",
          markdown: "# Rules",
          name: "plan-playbook",
          source: "skills/plan-playbook.ts",
        },
      ],
      { listedInSystem: true },
    ).skills!;

    expect(
      getAvailableSkills([
        { content: [{ text: announcement.render(undefined)!, type: "text" }], role: "user" },
      ]),
    ).toEqual([{ description: "Billing rules.", name: "plan-playbook" }]);
  });
});
