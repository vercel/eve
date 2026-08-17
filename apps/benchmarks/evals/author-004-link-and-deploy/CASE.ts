import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { vercelSetup } from "../vercel-setup.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: vercelSetup,
  async interact({ send }) {
    await send(
      "Deploy this project to production on the existing Vercel project wayfinder-production.",
    );
  },
});
