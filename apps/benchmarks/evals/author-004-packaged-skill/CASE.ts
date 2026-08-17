import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Add a packaged skill named `incident-response` for investigating production incidents. It should load when a user needs incident triage, guide the agent to establish a timeline, collect evidence, assess impact, and propose mitigations, and include a supporting `references/severity-levels.md` file that defines SEV1 and SEV2. Use the standard packaged skill layout rather than creating a tool.",
    );
  },
});
