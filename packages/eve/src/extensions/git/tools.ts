import { defineGhTool } from "./extension/lib/gh-tool.ts";
import extension from "./extension/extension.ts";

/** The Connect-brokered `gh` tool, bound to the `eve/extensions/git` mount's `github` config. */
export const gh = defineGhTool(() => extension.config.github);
