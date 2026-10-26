import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { GitHubAuthorize, GitHubConfig } from "./lib/github-shell.ts";

export type { GitHubLeaseRule } from "./lib/github-shell.ts";
export type { GitHubCoAuthor } from "./lib/github-shell.ts";
export type { GitHubAuthorize, GitHubAuthorizeRequest } from "./lib/github-shell.ts";
export type GitHubLeaseBroker = GitHubConfig["broker"];
export type GitHubAttribution = NonNullable<GitHubConfig["attribution"]>;

const fn = <T>() => z.custom<T>((value) => typeof value === "function");

export default defineExtension({
  config: z.object({
    /**
     * Connect-brokered GitHub access. When set, the extension contributes the
     * authenticated `gh` tool and the signed-commit pull request workflow.
     * Without it, agents use the `gh` and `git` CLIs from their own shell.
     */
    github: z
      .object({
        connector: z.string().min(1),
        /** Removed. Restrict organizations with `authorize`. */
        org: z
          .undefined({
            error:
              'was removed. The GitHub App installation is now the boundary; restrict organizations with authorize, e.g. authorize: ({ repository }) => repository.startsWith("acme/").',
          })
          .optional(),
        broker: fn<GitHubLeaseBroker>(),
        /**
         * Resolves the person each turn publishes for. Their
         * `Co-authored-by` trailer ends signed commits and new pull requests.
         */
        attribution: fn<GitHubAttribution>().optional(),
        /**
         * Called before each `gh` command with the session's caller, the
         * declared repository, and its scoped token. Return `false` to deny.
         * Without it, the GitHub App installation is the only boundary: every
         * repository the app can access, in any organization, is reachable.
         */
        authorize: fn<GitHubAuthorize>().optional(),
      })
      .strict()
      .optional(),
  }),
});
