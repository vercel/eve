import { defineDynamic } from "eve/tools";

import extension from "../extension.ts";
import { defineGhTool } from "../lib/gh-tool.ts";

/** Present only with `github` config; otherwise agents use `gh` from their own shell. */
export default defineDynamic({
  resolve: () =>
    extension.config.github === undefined ? null : defineGhTool(() => extension.config.github),
});
