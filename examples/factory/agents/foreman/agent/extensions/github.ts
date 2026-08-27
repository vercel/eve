import githubExtension from "@github-tools/eve-extension";
import { factoryRepo } from "#lib/constants.js";
import {
  closeIssuePolicy,
  commentPolicy,
  createPullRequestPolicy,
  labelPolicy,
  shipPolicy,
  updateIssuePolicy,
  writePolicy,
} from "#lib/github/approval.js";
import { GITHUB_CONNECTOR } from "#lib/github/credentials.js";

/**
 * GitHub tool surface for the orchestrator, mounted as an eve extension.
 *
 * @remarks
 * - Tools appear to the model as `github__<name>`; credentials are brokered
 *   by Vercel Connect through {@link GITHUB_CONNECTOR}, resolved per call and
 *   never exposed to the model. `context` fills `owner`/`repo` from
 *   `FACTORY_REPO` so tool calls omit them.
 * - `include` is the allowlist; there is no preset. Reads, triage writes, and
 *   PR authoring are in; merge tools are deliberately absent (a person merges
 *   in the GitHub UI), and so are repo administration, gists (they 403 over
 *   Connect installation tokens), releases, and CI mutation.
 * - `requireApproval` doubles as the authorization policy
 *   (`agent/lib/github/approval.ts`): trusted callers run reversible writes
 *   without a card, unattended factory runs are denied everything except
 *   labels, progress comments on their own intake issue, closing or reopening
 *   issues, and draft pull requests (a card would strand them). Closing an
 *   issue is reversible triage, so it runs for every caller; only shipping
 *   (marking a non-draft or ready-for-review PR) parks for a person no matter
 *   who asks. Write tools not listed here would keep the SDK's
 *   approval-by-default.
 */
export default githubExtension({
  connector: GITHUB_CONNECTOR,
  context: factoryRepo,
  include: [
    "getRepository",
    "getRepositoryTree",
    "getFileContent",
    "searchCode",
    "listBranches",
    "listCommits",
    "getCommit",
    "compareCommits",
    "searchIssues",
    "listIssues",
    "getIssueContext",
    "listIssueComments",
    "createIssue",
    "updateIssue",
    "closeIssue",
    "addIssueComment",
    "listLabels",
    "addLabels",
    "removeLabel",
    "addAssignees",
    "removeAssignees",
    "listPullRequests",
    "getPullRequestContext",
    "listPullRequestFiles",
    "listPullRequestReviews",
    "createPullRequest",
    "updatePullRequest",
    "addPullRequestComment",
    "requestReviewers",
    "listCheckRuns",
    "getCiFailureContext",
  ],
  requireApproval: {
    addAssignees: writePolicy,
    addIssueComment: commentPolicy,
    addLabels: labelPolicy,
    addPullRequestComment: writePolicy,
    closeIssue: closeIssuePolicy,
    createIssue: writePolicy,
    createPullRequest: createPullRequestPolicy,
    removeAssignees: writePolicy,
    removeLabel: labelPolicy,
    requestReviewers: writePolicy,
    updateIssue: updateIssuePolicy,
    updatePullRequest: shipPolicy,
  },
});
