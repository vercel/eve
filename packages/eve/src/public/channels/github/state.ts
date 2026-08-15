import {
  githubContinuationToken,
  type GitHubCiEvent,
  type GitHubCiWebhookEvent,
  type GitHubConversationKind,
  type GitHubConversationRef,
  type GitHubIssueCommentEvent,
  type GitHubIssueWebhookEvent,
  type GitHubPullRequestReviewCommentEvent,
  type GitHubPullRequestWebhookEvent,
} from "#public/channels/github/inbound.js";

/**
 * Durable, mutable per-conversation GitHub channel state, persisted as JSON.
 *
 * Which fields are populated depends on `conversationKind`: `review_thread`
 * state sets `reviewCommentId`/`reviewThreadRootCommentId`, issue and PR
 * timeline comments set `triggeringCommentId`, and issue/PR conversations set
 * `issueNumber`/`pullRequestNumber`. See the `stateFrom*` builders for the
 * exact mapping per kind.
 *
 * The checkout-derived fields (`checkoutPath`, `headSha`, `baseRef`) start
 * null. The default `turn.started` handler fills them in once it checks out
 * the repository, which is why the fields are mutable.
 */
export interface GitHubChannelState {
  baseRef: string | null;
  baseSha: string | null;
  checkoutPath: string | null;
  conversationKind: GitHubConversationKind;
  defaultBranch: string | null;
  headRef: string | null;
  headSha: string | null;
  installationId: number | null;
  issueNumber: number | null;
  owner: string;
  pullRequestNumber: number | null;
  repo: string;
  repositoryId: number;
  reviewCommentId: number | null;
  reviewThreadRootCommentId: number | null;
  triggeringCommentId: number | null;
  triggeringUserLogin: string | null;
}

/** Minimal receive target needed to seed GitHub channel state. */
export interface GitHubReceiveStateTarget {
  readonly installationId?: number;
  readonly issueNumber?: number;
  readonly pullRequestNumber?: number;
}

/** Initial empty GitHub channel state. */
export function initialGitHubState(): GitHubChannelState {
  return {
    baseRef: null,
    baseSha: null,
    checkoutPath: null,
    conversationKind: "issue",
    defaultBranch: null,
    headRef: null,
    headSha: null,
    installationId: null,
    issueNumber: null,
    owner: "",
    pullRequestNumber: null,
    repo: "",
    repositoryId: 0,
    reviewCommentId: null,
    reviewThreadRootCommentId: null,
    triggeringCommentId: null,
    triggeringUserLogin: null,
  };
}

/** Builds state for an issue or PR timeline comment. */
export function stateFromIssueCommentEvent(event: GitHubIssueCommentEvent): GitHubChannelState {
  return {
    ...initialGitHubState(),
    baseRef: event.baseRef,
    baseSha: event.baseSha,
    conversationKind: event.conversation.kind,
    defaultBranch: event.defaultBranch,
    headRef: event.headRef,
    headSha: event.headSha,
    installationId: event.installationId ?? null,
    issueNumber: event.comment.issueNumber,
    owner: event.repository.owner,
    pullRequestNumber: event.comment.pullRequestNumber,
    repo: event.repository.name,
    repositoryId: event.repository.id,
    triggeringCommentId: event.comment.id,
    triggeringUserLogin: event.sender.login,
  };
}

/** Builds state for an inline pull-request review comment. */
export function stateFromPullRequestReviewCommentEvent(
  event: GitHubPullRequestReviewCommentEvent,
): GitHubChannelState {
  return {
    ...initialGitHubState(),
    baseRef: event.baseRef,
    baseSha: event.baseSha,
    conversationKind: "review_thread",
    defaultBranch: event.defaultBranch,
    headRef: event.headRef,
    headSha: event.headSha,
    installationId: event.installationId ?? null,
    owner: event.repository.owner,
    pullRequestNumber: event.comment.pullRequestNumber,
    repo: event.repository.name,
    repositoryId: event.repository.id,
    reviewCommentId: event.comment.id,
    reviewThreadRootCommentId: event.comment.reviewThreadRootCommentId,
    triggeringCommentId: event.comment.id,
    triggeringUserLogin: event.sender.login,
  };
}

/** Builds state for an issue event hook dispatch. */
export function stateFromIssueEvent(event: GitHubIssueWebhookEvent): GitHubChannelState {
  return {
    ...initialGitHubState(),
    conversationKind: "issue",
    installationId: event.installationId ?? null,
    issueNumber: event.issue.issueNumber,
    owner: event.repository.owner,
    repo: event.repository.name,
    repositoryId: event.repository.id,
    triggeringUserLogin: event.sender.login,
  };
}

/** Builds state for a pull-request event hook dispatch. */
export function stateFromPullRequestEvent(
  event: GitHubPullRequestWebhookEvent,
): GitHubChannelState {
  return {
    ...initialGitHubState(),
    baseRef: event.baseRef,
    baseSha: event.baseSha,
    conversationKind: "pull_request",
    defaultBranch: event.defaultBranch,
    headRef: event.headRef,
    headSha: event.headSha,
    installationId: event.installationId ?? null,
    issueNumber: event.pullRequest.pullRequestNumber,
    owner: event.repository.owner,
    pullRequestNumber: event.pullRequest.pullRequestNumber,
    repo: event.repository.name,
    repositoryId: event.repository.id,
    triggeringUserLogin: event.sender.login,
  };
}

/** Builds pull-request state for a CI event hook dispatch. */
export function stateFromCiEvent(event: GitHubCiWebhookEvent): GitHubChannelState {
  const ci = ciPayload(event);
  const pullRequestNumber = ci.pullRequests[0] ?? null;
  return {
    ...initialGitHubState(),
    conversationKind: "pull_request",
    headSha: ci.headSha,
    installationId: event.installationId ?? null,
    issueNumber: pullRequestNumber,
    owner: event.repository.owner,
    pullRequestNumber,
    repo: event.repository.name,
    repositoryId: event.repository.id,
    triggeringUserLogin: event.sender.login,
  };
}

/** Builds state for proactive `receive()` calls. */
export function stateFromReceiveTarget(input: {
  readonly target: GitHubReceiveStateTarget;
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: number;
}): GitHubChannelState {
  const { target } = input;
  const conversationKind: GitHubConversationKind =
    target.pullRequestNumber !== undefined ? "pull_request" : "issue";
  return {
    ...initialGitHubState(),
    conversationKind,
    installationId: target.installationId ?? null,
    issueNumber:
      conversationKind === "issue"
        ? (target.issueNumber ?? null)
        : (target.pullRequestNumber ?? null),
    owner: input.owner,
    pullRequestNumber: target.pullRequestNumber ?? null,
    repo: input.repo,
    repositoryId: input.repositoryId,
  };
}

/** Reconstructs the channel-local GitHub conversation reference from state. */
export function conversationFromState(state: GitHubChannelState): GitHubConversationRef {
  return {
    issueNumber: state.issueNumber,
    kind: state.conversationKind,
    pullRequestNumber: state.pullRequestNumber,
  };
}

/** Builds the channel-local continuation token from durable state. */
export function continuationTokenFromState(state: GitHubChannelState): string {
  return githubContinuationToken({
    conversationKind: state.conversationKind,
    issueNumber: state.issueNumber,
    pullRequestNumber: state.pullRequestNumber,
    repositoryId: state.repositoryId,
    reviewThreadRootCommentId: state.reviewThreadRootCommentId,
  });
}

function ciPayload(event: GitHubCiWebhookEvent): GitHubCiEvent {
  if (event.kind === "check_suite") return event.checkSuite;
  if (event.kind === "check_run") return event.checkRun;
  return event.workflowRun;
}
