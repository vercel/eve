import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: emptyProject,
  async interact({ send }) {
    await send(
      "Create a new eve project in this directory for a concise travel assistant called Wayfinder. It should use the default model and be ready to build.",
    );
  },
});
