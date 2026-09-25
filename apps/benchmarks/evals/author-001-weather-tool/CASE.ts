import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "Add a get_weather tool to this agent. It should accept a city and return that city's temperature and conditions. The agent should be able to use it without asking for approval.",
    );
  },
});
