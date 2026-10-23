import {
  executeGitHubShell,
  GH_TOOL_DESCRIPTION,
  githubShellApproval,
  type GitHubShellInput,
} from "eve/extensions/git/sandbox";
import { defineDynamic, defineTool } from "eve/tools";

import extension from "../extension.ts";
import { gh } from "../lib/github-compat.ts";

/**
 * @deprecated Mount `eve/extensions/git` with `github` config.
 *
 * Defined inline rather than returning the static `gh` from `github-compat.ts`:
 * a dynamic tool's callbacks may only capture JSON values, so `execute` reads
 * the config from the module-level `extension` import. The schemas come from
 * the module-level `gh`, which keeps them in sync without new public exports.
 */
export default defineDynamic({
  events: {
    "session.started": () =>
      extension.config.github === undefined
        ? null
        : defineTool({
            description: GH_TOOL_DESCRIPTION,
            approval: ({ toolInput }) =>
              githubShellApproval(toolInput as GitHubShellInput | undefined),
            inputSchema: gh.inputSchema,
            outputSchema: gh.outputSchema,
            execute(input, ctx) {
              return executeGitHubShell(input, extension.config.github, {
                context: ctx,
                auth: ctx.session.auth.current,
                getSandbox: () => ctx.getSandbox(),
                sessionId: ctx.session.id,
              });
            },
          }),
  },
});
