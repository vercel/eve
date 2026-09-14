import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Add an eve packaged skill named `incident-response` at `agent/skills/incident-response/SKILL.md` for investigating production incidents. It should load when a user needs incident triage, guide the agent to establish a timeline, collect evidence, assess impact, and propose mitigations, and include `agent/skills/incident-response/references/severity-levels.md` defining SEV1 and SEV2. Use eve's packaged skill layout, not an OpenCode `.opencode/skills` directory and not a tool.",
    );
  },
});
