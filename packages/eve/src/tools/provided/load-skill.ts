import {
  executeLoadSkill,
  SKILL_INPUT_SCHEMA,
  SKILL_OUTPUT_SCHEMA,
} from "#execution/tools/load-skill.js";
import { defineTool } from "#tools/definition.js";
import { attachToolBehavior } from "#tools/behavior.js";

export const loadSkill = attachToolBehavior(
  defineTool({
    activity: {
      label: (input) =>
        activityLabel(
          "Load",
          typeof input === "object" && input !== null ? Reflect.get(input, "skill") : undefined,
        ),
    },
    description: [
      "Load the full instructions for one available skill by name or id.",
      "Use this tool when the request clearly matches a listed skill description or when the user explicitly asks for that skill.",
      "Loading adds the skill instructions to the current turn.",
      'Choose the "skill" value from the Available skills block.',
    ].join(" "),
    execute: executeLoadSkill,
    inputSchema: SKILL_INPUT_SCHEMA,
    outputSchema: SKILL_OUTPUT_SCHEMA,
  }),
  {
    availability: [],
    presentation: "load-skill",
  },
);

export default loadSkill;
