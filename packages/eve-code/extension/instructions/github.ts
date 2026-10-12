import { githubInstructions } from "eve/extensions/git/sandbox";
import { defineDynamic, defineInstructions, once } from "eve/instructions";

import { deprecatedGitHubConfigured } from "../lib/github-compat.ts";

/** @deprecated Mount `eve/extensions/git` with `github` config. */
export default defineDynamic({
  select: once,
  render: () =>
    deprecatedGitHubConfigured() ? defineInstructions({ content: githubInstructions(true) }) : null,
});
