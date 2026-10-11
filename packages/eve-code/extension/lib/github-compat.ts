/**
 * Deprecated `code({ github })` support. GitHub moved to `eve/extensions/git`;
 * these contributions resolve only while the deprecated `github` config is set,
 * so `code({})` contributes no GitHub tool, instructions, or pull request skill.
 */
import { defineGhTool } from "eve/extensions/git/sandbox";

import extension from "../extension.ts";

export function deprecatedGitHubConfigured(): boolean {
  return extension.config.github !== undefined;
}

/** @deprecated Mount `eve/extensions/git` with `github` config, or import `gh` from `eve/extensions/git/tools`. */
export const gh = defineGhTool(() => extension.config.github);
