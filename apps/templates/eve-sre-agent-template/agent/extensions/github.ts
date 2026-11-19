import githubExtension from "@github-tools/eve-extension";
import { GITHUB_CONNECTOR } from "#lib/constants.ts";

/**
 * Read-only access by default to GitHub, regardless of the scopes attached to the token.
 */
export default githubExtension({
  connector: GITHUB_CONNECTOR,
  exclude: ["getGist", "listGists", "listGistComments"],
  preset: "repo-explorer",
});
