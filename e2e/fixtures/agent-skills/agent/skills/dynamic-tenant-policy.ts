import { defineDynamic, defineSkill } from "eve/skills";

export const DYNAMIC_SKILL_TOKEN = "dynamic-skill-ok-P4K9";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return defineSkill({
        description:
          'Use ONLY when the user asks for the smoke-test dynamic tenant policy skill. Triggered by the literal phrase "dynamic tenant policy skill".',
        markdown: [
          "# Dynamic Tenant Policy Skill",
          "",
          "This skill is a fixture for the dynamic-skill smoke test.",
          "",
          "When the user asks you to follow this skill's instructions, reply with exactly the following text and nothing else. For any other request about this skill, such as reading its reference files, complete that request instead:",
          "",
          DYNAMIC_SKILL_TOKEN,
        ].join("\n"),
        files: {
          "references/policy.md": "Dynamic policy reference fixture.\n",
        },
      });
    },
  },
});
