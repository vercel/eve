import git from "eve/extensions/git";
import { brokerGitHubLease, GITHUB_CONNECTOR, GITHUB_ORG } from "../lib/github.ts";

// Without GITHUB_CONNECTOR the agent still works with code in its sandbox, but
// has no `git__gh` tool and no GitHub credentials.
export default git(
  GITHUB_CONNECTOR
    ? {
        github: {
          connector: GITHUB_CONNECTOR,
          broker: brokerGitHubLease,
          // GitHub App installation tokens, scoped to one repository per command,
          // so the agent reaches only repositories the app is installed on.
          principalType: "app",
          // The only access check on `git__gh`: commands run only for Slack users
          // (including their scheduled tasks) and, with GITHUB_ORG set, only
          // against repositories that account owns.
          authorize: ({ auth, owner }) =>
            auth?.authenticator === "slack-webhook" &&
            auth.principalType === "user" &&
            (GITHUB_ORG === undefined || owner.toLowerCase() === GITHUB_ORG),
        },
      }
    : {},
);
