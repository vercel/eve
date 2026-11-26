import git from "eve/extensions/git";

import { brokerGitHubLease, GITHUB_CONNECTOR } from "../lib/github";

const org = process.env.GITHUB_ORG;

// Without GITHUB_ORG the agent still edits and runs code in its sandbox,
// but there is no `git__gh` tool and no GitHub credentials.
// `authorize` is the only access control: a `gh` call runs only for
// repositories owned by GITHUB_ORG. A turn started from a GitHub comment may
// only act on the repository that triggered it, so a diff under review
// cannot steer the agent into other repositories.
export default git(
  org
    ? {
        github: {
          connector: GITHUB_CONNECTOR,
          broker: brokerGitHubLease,
          principalType: "app",
          authorize: ({ auth, owner, repository }) => {
            if (owner.toLowerCase() !== org.toLowerCase()) return false;
            if (auth?.authenticator !== "github-webhook") return true;
            const origin = auth.attributes.repository;
            return (
              typeof origin === "string" &&
              repository !== null &&
              repository.toLowerCase() === origin.toLowerCase()
            );
          },
        },
      }
    : {},
);
