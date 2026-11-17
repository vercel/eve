import { defineDynamic } from "eve/tools";

import extension from "../extension.ts";
import { defineGhTool } from "../lib/gh-tool.ts";

export default defineDynamic(() =>
  extension.config.github === undefined ? null : defineGhTool(() => extension.config.github),
);
