import { defineExtension } from "eve/extension";
import type { ToolAuthProvider } from "eve/tools";
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
/**
 * Callback that installs GitHub credential header rules into the sandbox's network policy for one command, then receives `null` to remove them.
 * It must preserve the consumer's other network rules.
 */
export type GitHubLeaseBroker = GitHubConfig["broker"];
export type { GitHubAttribution } from "./lib/github-shell.ts";

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

const githubBase = {
  broker: fn<GitHubLeaseBroker>(),
  /**
   * Resolves the person each turn publishes for. Their
   * `Co-authored-by` trailer ends signed commits and new pull requests.
   */
  attribution: fn<GitHubAttribution>().optional(),
};

const githubUser = {
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
};

/**
 * Adds GitHub support to an agent: GitHub instructions and a `pr` skill.
 * With `github` config, it also adds the Connect-brokered `gh` tool and signed commits; without it, the agent uses the `gh` and `git` CLIs from its own shell.
 */
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
          connector: z.string().min(1),
          /**
           * The agent's only GitHub access control. Called before each `gh`
           * command with the parsed argv, the caller, the declared owner and
           * repository, and the installation token. Return `true` to run it.
           */
          authorize: fn<GitHubAuthorize<GitHubAppAuthorizeRequest>>(),
          /**
           * Installation permissions each minted token carries, such as
           * `"contents:write"`. Omit it for every permission the App holds.
           */
          permissions: z.array(z.string().min(1)).min(1).optional(),
          /** `"app"` mints GitHub App installation tokens. */
          principalType: z.literal("app"),
        }),
        z
          .object({
            ...githubUser,
            /** Vercel Connect connector that holds each caller's GitHub token. */
            connector: z.string().min(1).optional(),
            /**
             * Your own source of each caller's GitHub token, in the shape a
             * connection's `auth` takes: `getToken`, and `startAuthorization`
             * and `completeAuthorization` to sign the caller in, with
             * `principalType: "user"`. `connector` is one such source, made for
             * you; set one or the other.
             */
            authorization: z
              .custom<ToolAuthProvider>(
                (value) =>
                  typeof value === "object" &&
                  value !== null &&
                  typeof (value as { getToken?: unknown }).getToken === "function" &&
                  (value as { principalType?: unknown }).principalType === "user",
                {
                  message:
                    'github.authorization must be an object with a `getToken` function and `principalType: "user"`; an app-scoped provider would share one token across callers',
                },
              )
              .optional(),
          })
          .refine(
            ({ connector, authorization }) =>
              (connector === undefined) !== (authorization === undefined),
            {
              message: "github: set exactly one of `connector` and `authorization`",
              path: ["connector"],
            },
          ),
      ])
      .optional(),
  }),
});
