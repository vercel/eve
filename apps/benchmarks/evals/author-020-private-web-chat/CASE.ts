import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  category: "features/frontend",
  startingPoint: simpleProject,
  async interact({ send }) {
    await send(
      "I want to run this agent as a private web app that only I can use. Add a Next.js web chat UI, served from the same deployment as the agent. In production, both the chat pages and the agent's HTTP API must require the username and password in the `APP_USERNAME` and `APP_PASSWORD` environment variables, and if either variable is missing nobody gets in. Don't deploy anything.",
    );
  },
});
