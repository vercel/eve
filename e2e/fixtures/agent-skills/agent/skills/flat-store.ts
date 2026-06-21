import { defineDynamic, defineSkill } from "eve/skills";

export const FLAT_STORE_TOKEN = "flat-store-bark-T9N4";

// A map entry is loadable under its bare key (`bark`); there is no automatic
// slug prefix.
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        bark: defineSkill({
          description:
            "Smoke-test fixture: a skill from a map resolver, loadable by bare key. " +
            'Only load when the user explicitly asks for "the bark skill".',
          markdown: [
            "# Bark Skill",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            FLAT_STORE_TOKEN,
          ].join("\n"),
        }),
      };
    },
  },
});
