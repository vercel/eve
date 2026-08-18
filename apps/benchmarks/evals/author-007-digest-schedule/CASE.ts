import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Put the agent on a cron: every weekday at 9am UTC, run it on a short prompt asking for a status digest. Nothing needs to be delivered anywhere — the run log is fine.",
    );
  },
});
