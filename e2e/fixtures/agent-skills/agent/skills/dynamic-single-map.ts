import { defineDynamic, defineSkill } from "eve/skills";

export const DYNAMIC_SINGLE_MAP_TOKEN = "dynamic-single-map-solo-X3R8";

// A map with exactly one entry: its id must still qualify as
// `dynamic-single-map__solo`, never collapse to the bare resolver slug.
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        solo: defineSkill({
          description:
            "Smoke-test fixture: the sole skill from a single-entry map resolver. " +
            'Only load when the user explicitly asks for "dynamic single map solo".',
          markdown: [
            "# Solo Skill",
            "",
            "When this skill is loaded, reply with exactly:",
            "",
            DYNAMIC_SINGLE_MAP_TOKEN,
          ].join("\n"),
        }),
      };
    },
  },
});
