import { defineDynamic, defineSkill } from "eve/skills";

export const DYNAMIC_SINGLE_MAP_TOKEN = "dynamic-single-map-solo-X3R8";

// Manual namespacing: map entries take the bare key verbatim, so the author
// prefixes the key to keep the loadable id unique (`dynamic-single-map__solo`).
export default defineDynamic({
  events: {
    "session.started": async () => {
      return {
        "dynamic-single-map__solo": defineSkill({
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
