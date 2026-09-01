import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "wayfinder",
  async interact({ send }) {
    await send(
      "Create a new eve project named `wayfinder` for a concise travel assistant called Wayfinder. It should use the default model and be ready to build.",
    );
  },
});
