import { defineExtension } from "eve/extension";
import { z } from "zod";

import type {
  GitHubAppAuthorizeRequest,
  GitHubAttribution,
  GitHubAuthorize,
  GitHubConfig,
  GitHubUserAuthorizeRequest,
} from "./lib/github-shell.ts";

export type { GitHubLeaseRule } from "./lib/github-shell.ts";
export type { GitHubCoAuthor } from "./lib/github-shell.ts";
export type {
  GitHubAppAuthorizeRequest,
  GitHubAuthorize,
  GitHubAuthorizeRequest,
  GitHubUserAuthorizeRequest,
} from "./lib/github-shell.ts";
export type GitHubLeaseBroker = GitHubConfig["broker"];
export type { GitHubAttribution } from "./lib/github-shell.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

const githubBase = {
  connector: z.string().min(1),
  broker: fn<GitHubLeaseBroker>(),
  /**
   * Resolves the person each turn publishes for. Their
   * `Co-authored-by` trailer ends signed commits and new pull requests.
   */
  attribution: fn<GitHubAttribution>().optional(),
};

export default defineExtension({
  config: z.object({
    /**
     * Connect-brokered GitHub access. When set, the extension contributes the
     * authenticated `gh` tool and the signed-commit pull request workflow.
     * Without it, agents use the `gh` and `git` CLIs from their own shell.
     * `principalType` selects whose token runs commands and what `authorize`
     * receives.
     */
    github: z
      .discriminatedUnion("principalType", [
        z.object({
          ...githubBase,
          /**
           * The agent's only GitHub access control. Called before each `gh`
           * command with the parsed argv, the caller, the declared owner and
           * repository, and the installation token. Return `true` to run it.
           */
          authorize: fn<GitHubAuthorize<GitHubAppAuthorizeRequest>>(),
          /** `"app"` mints GitHub App installation tokens. */
          principalType: z.literal("app"),
        }),
        z.object({
          ...githubBase,
          /**
           * The agent's only GitHub access control. Called before each `gh`
           * command with the parsed argv, the caller, the declared repository,
           * and the caller's token. Return `true` to run it.
           */
          authorize: fn<GitHubAuthorize<GitHubUserAuthorizeRequest>>(),
          /**
           * `"user"` uses the caller's own GitHub token, as in `connect({
           * connector, principalType: "user" })`: eve signs them in when needed
           * and again when GitHub rejects the token.
           */
          principalType: z.literal("user"),
        }),
      ])
      .optional(),
  }),
});
