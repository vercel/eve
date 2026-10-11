import { defineDynamic, defineInstructions } from "eve/instructions";

import extension from "../extension.ts";
import { githubInstructions } from "../lib/github-guidance.ts";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({ content: githubInstructions(extension.config.github !== undefined) }),
  },
});
