import { defineDynamic, defineInstructions, once } from "eve/instructions";

import extension from "../extension.ts";
import { githubInstructions } from "../lib/github-guidance.ts";

export default defineDynamic({
  select: once,
  render: () =>
    defineInstructions({ content: githubInstructions(extension.config.github !== undefined) }),
});
