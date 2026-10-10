import { githubInstructions } from "eve/extensions/git/sandbox";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { deprecatedGitHubConfigured } from "../lib/github-compat.ts";

/** @deprecated Mount `eve/extensions/git` with `github` config. */
export default defineDynamic({
  select: () => null,
  resolve: () =>
    deprecatedGitHubConfigured() ? defineInstructions({ content: githubInstructions(true) }) : null,
});
