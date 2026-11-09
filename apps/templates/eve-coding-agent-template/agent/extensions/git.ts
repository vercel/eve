import git from "eve/extensions/git";

import { brokerGitHubLease, GITHUB_CONNECTOR } from "../lib/github";

const org = process.env.GITHUB_ORG;

// Without GITHUB_ORG the agent still edits and runs code in its sandbox,
// but there is no `git__gh` tool and no GitHub credentials.
// `org` keeps the eve release pinned by this template's lockfile working;
// newer eve ignores it and enforces `authorize`. Drop `org` once the lockfile
// pins an eve release where `authorize` is required.
const github = org && {
  connector: GITHUB_CONNECTOR,
  org,
  broker: brokerGitHubLease,
  principalType: "app" as const,
  // Older releases pass only `repository`; newer ones pass the installation `owner`.
  authorize: ({ owner, repository }: { owner?: string; repository: string | null }) =>
    (owner ?? repository?.split("/")[0])?.toLowerCase() === org.toLowerCase(),
};

export default git(github ? { github } : {});
