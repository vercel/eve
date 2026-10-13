import { defineDynamic, once } from "eve/tools";

import { deprecatedGitHubConfigured, gh } from "../lib/github-compat.ts";

/** @deprecated Mount `eve/extensions/git` with `github` config. */
export default defineDynamic({
  select: once,
  render: () => (deprecatedGitHubConfigured() ? gh : null),
});
