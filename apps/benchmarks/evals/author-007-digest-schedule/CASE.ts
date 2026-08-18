import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Have the agent run itself every weekday at 9am UTC to sweep our open support threads and write up a digest. Nothing needs to be delivered anywhere — the run log is fine.",
    );
  },
});
