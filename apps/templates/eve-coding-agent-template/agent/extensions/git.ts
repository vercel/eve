import git from "eve/extensions/git";

import { brokerGitHubLease, GITHUB_CONNECTOR } from "../lib/github";

const org = process.env.GITHUB_ORG;

// Without GITHUB_ORG the agent still edits and runs code in its sandbox,
// but there is no `git__gh` tool and no GitHub credentials.
// `authorize` is the only access control: a `gh` call runs only for
// repositories owned by GITHUB_ORG.
export default git(
  org
    ? {
        github: {
          connector: GITHUB_CONNECTOR,
          broker: brokerGitHubLease,
          principalType: "app",
          authorize: ({ owner }) => owner.toLowerCase() === org.toLowerCase(),
        },
      }
    : {},
);
