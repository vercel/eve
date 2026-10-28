import git from "eve/extensions/git";

import { brokerGitHubLease, GITHUB_CONNECTOR } from "../lib/github";

const org = process.env.GITHUB_ORG;

// Without GITHUB_ORG the agent still edits and runs code in its sandbox,
// but there is no `git__gh` tool and no GitHub credentials.
//
// Tokens are minted for the GitHub App, not the caller, so anyone who can
// invoke the agent from any channel shares the app's access to every
// repository it is installed on.
export default git(
  org ? { github: { connector: GITHUB_CONNECTOR, org, broker: brokerGitHubLease } } : {},
);
