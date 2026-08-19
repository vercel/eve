import { defineAuthoringCase, emptyProject } from "../../lib/authoring-case.js";

export default defineAuthoringCase({
  startingPoint: emptyProject,
  projectDirectory: "wayfinder",
  async interact({ send }) {
    await send(
      "Create a new eve project named `wayfinder` for a concise travel assistant called Wayfinder. Keep the model `eve init` selects and make the project ready to build. Leave the Git repository `eve init` creates unchanged; do not configure Git identity or make commits.",
    );
  },
});
