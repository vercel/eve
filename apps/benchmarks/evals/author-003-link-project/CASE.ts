import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { vercelSetup } from "../vercel-setup.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: vercelSetup,
  async interact({ send }) {
    await send(
      "Link this project to the existing Vercel project wayfinder-production and pull its environment so it is ready to deploy.",
    );
  },
});
