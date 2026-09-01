import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "In this eve project, add an agent schedule under `agent/schedules/`: every weekday at 9am UTC, run the agent on a short prompt asking for a status digest. Nothing needs to be delivered anywhere — the eve run log is fine.",
    );
  },
});
