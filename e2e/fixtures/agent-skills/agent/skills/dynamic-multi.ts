import { defineDynamic, defineSkill } from "eve/skills";

export const DYNAMIC_MULTI_ALPHA_TOKEN = "dynamic-multi-alpha-Q8V3";
export const DYNAMIC_MULTI_BETA_TOKEN = "dynamic-multi-beta-J5W1";

export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        alpha: defineSkill({
          description:
            "Smoke-test fixture: alpha skill from a multi-skill resolver. " +
            'Only load when the user explicitly asks for "dynamic multi alpha".',
          markdown: [
            "# Alpha Skill",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            DYNAMIC_MULTI_ALPHA_TOKEN,
          ].join("\n"),
        }),
        beta: defineSkill({
          description:
            "Smoke-test fixture: beta skill from a multi-skill resolver. " +
            'Only load when the user explicitly asks for "dynamic multi beta".',
          markdown: [
            "# Beta Skill",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            DYNAMIC_MULTI_BETA_TOKEN,
          ].join("\n"),
        }),
      };
    },
  },
});
