import { defineDynamic, defineSkill } from "eve/skills";

export const FLAT_STORE_TOKEN = "flat-store-bark-T9N4";

// `namespace: false`: the map entry is loadable under its bare key
// (`bark`), not the slug-qualified `flat-store__bark`.
export default defineDynamic({
  namespace: false,
  events: {
    "session.started": async () => {
      return {
        bark: defineSkill({
          description:
            "Smoke-test fixture: a skill from a non-namespaced map resolver. " +
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
