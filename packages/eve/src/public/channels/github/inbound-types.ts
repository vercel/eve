import type { JsonObject } from "#shared/json.js";

/** GitHub conversation kinds represented by the channel state. */
export type GitHubConversationKind = "issue" | "pull_request" | "review_thread";

/** Stable repository identity normalized from webhook payloads. */
export interface GitHubRepositoryRef {
  readonly fullName: string;
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  readonly private: boolean;
}

/** GitHub actor metadata normalized from webhook payloads. */
export interface GitHubUser {
  readonly htmlUrl: string | undefined;
  readonly id: number;
  readonly login: string;
  readonly type: string;
  readonly url: string | undefined;
}

/** GitHub webhook delivery metadata. */
export interface GitHubDelivery {
  readonly event: string;
  readonly hookId: string | undefined;
  readonly id: string;
}

/** Channel-local conversation reference. */
export interface GitHubConversationRef {
  readonly issueNumber: number | null;
  readonly kind: GitHubConversationKind;
  readonly pullRequestNumber: number | null;
}

/**
 * Normalized GitHub comment handed to the `onComment` hook. Covers issue and PR
 * timeline comments and inline review comments alike; `ctx.conversation.kind`
 * distinguishes them.
 */
export interface GitHubComment {
  readonly author: GitHubUser | undefined;
  readonly body: string;
  readonly htmlUrl: string | undefined;
  readonly id: number;
  readonly raw: JsonObject;
  readonly url: string | undefined;
}

/** Normalized issue/PR timeline comment. */
export interface GitHubIssueComment {
  readonly author: GitHubUser | undefined;
  readonly body: string;
  readonly htmlUrl: string | undefined;
  readonly id: number;
  readonly issueNumber: number;
  readonly pullRequestNumber: number | null;
  readonly raw: JsonObject;
  readonly url: string | undefined;
}

/** Normalized inline pull-request review comment. */
export interface GitHubPullRequestReviewComment {
  readonly author: GitHubUser | undefined;
  readonly body: string;
  readonly htmlUrl: string | undefined;
  readonly id: number;
  readonly inReplyToId: number | null;
  readonly pullRequestNumber: number;
  readonly raw: JsonObject;
  readonly reviewThreadRootCommentId: number;
  readonly url: string | undefined;
}

/**
 * Common `issues` webhook actions, kept open to any action GitHub sends so
 * authors get autocomplete without losing forward compatibility.
 */
export type GitHubIssueAction =
  | "assigned"
  | "closed"
  | "edited"
  | "labeled"
  | "opened"
  | "reopened"
  | "unassigned"
  | "unlabeled"
  | (string & {});

/** Common `pull_request` webhook actions, kept open to any action GitHub sends. */
export type GitHubPullRequestAction =
  | "closed"
  | "edited"
  | "labeled"
  | "opened"
  | "ready_for_review"
  | "reopened"
  | "synchronize"
  | "unlabeled"
  | (string & {});

/** Normalized issue event payload. */
export interface GitHubIssueEvent {
  readonly action: GitHubIssueAction;
  readonly issueNumber: number;
  readonly raw: JsonObject;
}

/** Normalized pull-request event payload. */
export interface GitHubPullRequestEvent {
  readonly action: GitHubPullRequestAction;
  readonly headSha: string | null;
  readonly pullRequestNumber: number;
  readonly raw: JsonObject;
}

/** GitHub App identity attached to CI webhook payloads. */
export interface GitHubAppRef {
  readonly slug: string | null;
}

/** Common fields normalized from GitHub CI webhook payloads. */
export interface GitHubCiEvent {
  readonly action: string;
  readonly app: GitHubAppRef;
  readonly conclusion: string | null;
  readonly headSha: string | null;
  readonly pullRequests: readonly number[];
  readonly raw: JsonObject;
  readonly status: string | null;
}

/** Normalized `check_suite` webhook payload. */
export interface GitHubCheckSuiteEvent extends GitHubCiEvent {
  readonly checkSuiteId: number;
}

/** Normalized `check_run` webhook payload. */
export interface GitHubCheckRunEvent extends GitHubCiEvent {
  readonly checkRunId: number;
}

/** Normalized `workflow_run` webhook payload. */
export interface GitHubWorkflowRunEvent extends GitHubCiEvent {
  readonly workflowRunId: number;
}

/** Normalized payload accepted by one of the GitHub CI event hooks. */
export type GitHubCiPayload = GitHubCheckRunEvent | GitHubCheckSuiteEvent | GitHubWorkflowRunEvent;

export interface GitHubInboundEventBase {
  readonly delivery: GitHubDelivery;
  readonly installationId: number | undefined;
  readonly raw: JsonObject;
  readonly repository: GitHubRepositoryRef;
  readonly sender: GitHubUser;
}

export interface GitHubPingEvent extends GitHubInboundEventBase {
  readonly kind: "ping";
}

export interface GitHubIssueCommentEvent extends GitHubInboundEventBase {
  readonly action: string;
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly comment: GitHubIssueComment;
  readonly conversation: GitHubConversationRef;
  readonly defaultBranch: string | null;
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly kind: "issue_comment";
}

export interface GitHubPullRequestReviewCommentEvent extends GitHubInboundEventBase {
  readonly action: string;
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly comment: GitHubPullRequestReviewComment;
  readonly conversation: GitHubConversationRef;
  readonly defaultBranch: string | null;
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly kind: "pull_request_review_comment";
}

export interface GitHubIssueWebhookEvent extends GitHubInboundEventBase {
  readonly action: string;
  readonly conversation: GitHubConversationRef;
  readonly issue: GitHubIssueEvent;
  readonly kind: "issues";
}

export interface GitHubPullRequestWebhookEvent extends GitHubInboundEventBase {
  readonly action: string;
  readonly baseRef: string | null;
  readonly baseSha: string | null;
  readonly conversation: GitHubConversationRef;
  readonly defaultBranch: string | null;
  readonly headRef: string | null;
  readonly headSha: string | null;
  readonly kind: "pull_request";
  readonly pullRequest: GitHubPullRequestEvent;
}

export interface GitHubCheckSuiteWebhookEvent extends GitHubInboundEventBase {
  readonly checkSuite: GitHubCheckSuiteEvent;
  readonly conversation: GitHubConversationRef;
  readonly kind: "check_suite";
}

export interface GitHubCheckRunWebhookEvent extends GitHubInboundEventBase {
  readonly checkRun: GitHubCheckRunEvent;
  readonly conversation: GitHubConversationRef;
  readonly kind: "check_run";
}

export interface GitHubWorkflowRunWebhookEvent extends GitHubInboundEventBase {
  readonly conversation: GitHubConversationRef;
  readonly kind: "workflow_run";
  readonly workflowRun: GitHubWorkflowRunEvent;
}

/** Parsed CI webhook envelopes consumed by the GitHub channel. */
export type GitHubCiWebhookEvent =
  | GitHubCheckRunWebhookEvent
  | GitHubCheckSuiteWebhookEvent
  | GitHubWorkflowRunWebhookEvent;

/** Parsed GitHub webhook event shape consumed by the channel. */
export type GitHubInboundEvent =
  | GitHubCheckRunWebhookEvent
  | GitHubCheckSuiteWebhookEvent
  | GitHubIssueCommentEvent
  | GitHubIssueWebhookEvent
  | GitHubPingEvent
  | GitHubPullRequestReviewCommentEvent
  | GitHubPullRequestWebhookEvent
  | GitHubWorkflowRunWebhookEvent;

/** Parsed mention trigger for a bot-directed GitHub comment. */
export interface GitHubCommentTrigger {
  readonly kind: "mention";
  readonly message: string;
  readonly token: string;
}
