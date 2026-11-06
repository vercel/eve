import git from "eve/extensions/git";
import { brokerGitHubLease, GITHUB_CONNECTOR, GITHUB_ORG } from "../lib/github.ts";

const org = GITHUB_ORG?.toLowerCase();

// Without GITHUB_ORG the agent still works with code in its sandbox, but has no
// `git__gh` tool and no GitHub credentials.
export default git(
  org
    ? {
        github: {
          connector: GITHUB_CONNECTOR,
          broker: brokerGitHubLease,
          // GitHub App installation tokens, scoped to one repository per command.
          principalType: "app",
          // The only access control on `git__gh`: commands run only for Slack users
          // (including their scheduled tasks) and only against GITHUB_ORG.
          authorize: ({ auth, owner }) =>
            auth?.authenticator === "slack-webhook" &&
            auth.principalType === "user" &&
            owner.toLowerCase() === org,
        },
      }
    : {},
);
