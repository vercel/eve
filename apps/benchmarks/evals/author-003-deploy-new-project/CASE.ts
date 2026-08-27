import { defineAuthoringCase, simpleProject } from "../../lib/authoring-case.js";
import { vercelSetup } from "../vercel-setup.js";

export default defineAuthoringCase({
  startingPoint: simpleProject,
  setup: vercelSetup,
  async interact({ send }) {
    await send("Deploy my agent to production using a new Vercel project called field-notes.");
  },
});
