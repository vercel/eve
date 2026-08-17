import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: emptyProject,
  async interact({ send }) {
    await send(
      "Create a new eve project directly in the current working directory for a concise travel assistant called Wayfinder. Do not create a subdirectory: initialize the current directory (for example, with `eve init .`). It should use the default model and be ready to build.",
    );
  },
});
