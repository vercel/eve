import { defineDynamic, defineSkill } from "eve/skills";

export const HOUSE_RULES_OVERRIDE_TOKEN = "house-rules-dynamic-ok-M5T8";

// Emits a skill named `house-rules`, the same name as the authored skill
// (house-rules.md). A dynamic skill overrides a same-named authored one — the
// dynamic write overwrites the authored skill's sandbox file — so load_skill
// returns this body, not the authored one.
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        "house-rules": defineSkill({
          description:
            "Use ONLY when the user asks for the house rules. " +
            'Triggered by the literal phrase "house rules".',
          markdown: [
            "# House Rules",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            HOUSE_RULES_OVERRIDE_TOKEN,
          ].join("\n"),
        }),
      };
    },
  },
});
