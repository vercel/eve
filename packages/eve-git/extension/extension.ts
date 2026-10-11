import { defineExtension } from "eve/extension";
import { z } from "zod";

import type { GitHubConfig } from "./lib/github-shell.ts";

export type { GitHubLeaseRule } from "./lib/github-shell.ts";
export type GitHubLeaseBroker = GitHubConfig["broker"];

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
        org: z.string().min(1),
        broker: fn<GitHubLeaseBroker>(),
      })
      .optional(),
  }),
});
