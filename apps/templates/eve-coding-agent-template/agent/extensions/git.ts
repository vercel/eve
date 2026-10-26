import git from "eve/extensions/git";

import { brokerGitHubLease, GITHUB_CONNECTOR } from "../lib/github";

// Lowercase GitHub organizations or users whose repositories `git__gh` may
// access, such as ["acme", "acme-labs"]. While empty, the agent still edits and
// runs code in its sandbox, but there is no `git__gh` tool and no GitHub credentials.
const orgs: string[] = [];

export default git(
  orgs.length > 0
    ? {
        github: {
          connector: GITHUB_CONNECTOR,
          broker: brokerGitHubLease,
          // The GitHub App can reach every installation; only these owners are allowed.
          authorize: ({ repository }) => orgs.includes(repository.split("/")[0]!.toLowerCase()),
        },
      }
    : {},
);
