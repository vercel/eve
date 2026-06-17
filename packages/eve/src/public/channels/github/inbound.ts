import type { TextPart, UserContent } from "ai";

import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

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

/** Verified GitHub webhook delivery headers. */
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

interface GitHubInboundEventBase {
  readonly delivery: GitHubDelivery;
  readonly installationId: number | undefined;
  readonly raw: JsonObject;
  readonly repository: GitHubRepositoryRef;
  readonly sender: GitHubUser;
}

/** Parsed GitHub webhook event shape consumed by the channel. */
export type GitHubInboundEvent =
  | GitHubIssueCommentEvent
  | GitHubIssueWebhookEvent
  | GitHubPingEvent
  | GitHubPullRequestReviewCommentEvent
  | GitHubPullRequestWebhookEvent;

/** Parsed mention trigger for a bot-directed GitHub comment. */
export interface GitHubCommentTrigger {
  readonly kind: "mention";
  readonly message: string;
  readonly token: string;
}

/** Builds the channel-local continuation token for a GitHub conversation. */
export function githubContinuationToken(input: {
  readonly conversationKind: GitHubConversationKind;
  readonly issueNumber?: number | null;
  readonly pullRequestNumber?: number | null;
  readonly repositoryId: number;
  readonly reviewThreadRootCommentId?: number | null;
}): string {
  if (input.conversationKind === "issue") {
    return `repo:${input.repositoryId}:issue:${requiredNumber(input.issueNumber, "issueNumber")}`;
  }
  if (input.conversationKind === "pull_request") {
    return `repo:${input.repositoryId}:pull:${requiredNumber(
      input.pullRequestNumber,
      "pullRequestNumber",
    )}`;
  }
  return `repo:${input.repositoryId}:pull:${requiredNumber(
    input.pullRequestNumber,
    "pullRequestNumber",
  )}:review-comment:${requiredNumber(
    input.reviewThreadRootCommentId,
    "reviewThreadRootCommentId",
  )}`;
}

/** Returns true when a comment @mentions the bot and should wake the channel. */
export function shouldDispatchGitHubComment(input: {
  readonly author?: GitHubUser;
  readonly body: string;
  readonly botName?: string;
}): boolean {
  if (isIgnoredGitHubComment(input.body, input.author, input.botName)) return false;
  return extractGitHubCommentTrigger(input) !== null;
}

/** Extracts and strips the bot `@mention` from a comment body. */
export function extractGitHubCommentTrigger(input: {
  readonly body: string;
  readonly botName?: string;
}): GitHubCommentTrigger | null {
  const botName = input.botName?.trim();
  if (!botName) return null;
  const mention = new RegExp(`@${escapeRegExp(botName)}(?=$|[^A-Za-z0-9_-])`, "iu").exec(
    input.body,
  );
  if (mention === null) return null;
  const start = mention.index;
  const end = start + mention[0].length;
  const message = `${input.body.slice(0, start)}${input.body.slice(end)}`.trim();
  return { kind: "mention", message, token: mention[0] };
}

/** Parses GitHub webhook headers and body into an eve-owned event shape. */
export function parseGitHubWebhookEvent(input: {
  readonly body: string;
  readonly contentType?: string;
  readonly headers: Headers;
}): GitHubInboundEvent | null {
  const eventName = input.headers.get("x-github-event") ?? "";
  const deliveryId = input.headers.get("x-github-delivery") ?? "";
  if (!eventName || !deliveryId) return null;

  const raw = decodePayload(input.body, input.contentType);
  const repository = normalizeRepository(raw.repository);
  const sender = normalizeUser(raw.sender);
  if (repository === null || sender === undefined) return null;

  const base = {
    delivery: {
      event: eventName,
      hookId: input.headers.get("x-github-hook-id") ?? undefined,
      id: deliveryId,
    },
    installationId: readInstallationId(raw.installation),
    raw,
    repository,
    sender,
  };

  if (eventName === "ping") return { ...base, kind: "ping" };
  if (eventName === "issue_comment") return parseIssueCommentEvent(base);
  if (eventName === "pull_request_review_comment") {
    return parsePullRequestReviewCommentEvent(base);
  }
  if (eventName === "issues") return parseIssueEvent(base);
  if (eventName === "pull_request") return parsePullRequestEvent(base);
  return null;
}

/** Renders deterministic GitHub metadata for the model-visible turn. */
export function formatGitHubContextBlock(input: {
  readonly commentUrl?: string;
  readonly deliveryId: string;
  readonly headSha?: string | null;
  readonly issueNumber?: number | null;
  readonly pullRequestNumber?: number | null;
  readonly repository: GitHubRepositoryRef;
  readonly sender: GitHubUser;
}): string {
  const lines = [
    "<github_context>",
    `repository: ${input.repository.fullName}`,
    `repository_id: ${input.repository.id}`,
    ...(input.issueNumber !== undefined && input.issueNumber !== null
      ? [`issue_number: ${input.issueNumber}`]
      : []),
    ...(input.pullRequestNumber !== undefined && input.pullRequestNumber !== null
      ? [`pull_request_number: ${input.pullRequestNumber}`]
      : []),
    `sender: ${input.sender.login}`,
    `sender_type: ${input.sender.type}`,
    ...(input.commentUrl ? [`comment_url: ${input.commentUrl}`] : []),
    ...(input.headSha ? [`head_sha: ${input.headSha}`] : []),
    `delivery_id: ${input.deliveryId}`,
    "</github_context>",
  ];
  return lines.join("\n");
}

/** Prepends a `<github_context>` block to the inbound turn message. */
export function prependGitHubContext(
  message: string | UserContent,
  block: string,
): string | UserContent {
  if (typeof message === "string") {
    return message.length > 0 ? `${block}\n\n${message}` : block;
  }
  const contextPart: TextPart = { text: block, type: "text" };
  return [contextPart, ...message];
}

function parseIssueCommentEvent(base: GitHubInboundEventBase): GitHubIssueCommentEvent | null {
  const issue = isObject(base.raw.issue) ? base.raw.issue : null;
  const rawComment = isObject(base.raw.comment) ? parseJsonObject(base.raw.comment) : null;
  const issueNumber = typeof issue?.number === "number" ? issue.number : undefined;
  if (rawComment === null || issue === null || issueNumber === undefined) return null;

  const pullRequestNumber = isObject(issue.pull_request) ? issueNumber : null;
  const action = readAction(base.raw);
  const comment: GitHubIssueComment = {
    author: normalizeUser(rawComment.user),
    body: typeof rawComment.body === "string" ? rawComment.body : "",
    htmlUrl: typeof rawComment.html_url === "string" ? rawComment.html_url : undefined,
    id: typeof rawComment.id === "number" ? rawComment.id : 0,
    issueNumber,
    pullRequestNumber,
    raw: rawComment,
    url: typeof rawComment.url === "string" ? rawComment.url : undefined,
  };
  return {
    ...base,
    action,
    baseRef: null,
    baseSha: null,
    comment,
    conversation: {
      issueNumber,
      kind: pullRequestNumber === null ? "issue" : "pull_request",
      pullRequestNumber,
    },
    defaultBranch: null,
    headRef: null,
    headSha: null,
    kind: "issue_comment",
  };
}

function parsePullRequestReviewCommentEvent(
  base: GitHubInboundEventBase,
): GitHubPullRequestReviewCommentEvent | null {
  const rawComment = isObject(base.raw.comment) ? parseJsonObject(base.raw.comment) : null;
  const pullRequest = isObject(base.raw.pull_request) ? base.raw.pull_request : null;
  const pullRequestNumber =
    typeof pullRequest?.number === "number" ? pullRequest.number : undefined;
  if (rawComment === null || pullRequestNumber === undefined) return null;

  const id = typeof rawComment.id === "number" ? rawComment.id : 0;
  const inReplyToId =
    typeof rawComment.in_reply_to_id === "number" ? rawComment.in_reply_to_id : null;
  const comment: GitHubPullRequestReviewComment = {
    author: normalizeUser(rawComment.user),
    body: typeof rawComment.body === "string" ? rawComment.body : "",
    htmlUrl: typeof rawComment.html_url === "string" ? rawComment.html_url : undefined,
    id,
    inReplyToId,
    pullRequestNumber,
    raw: rawComment,
    reviewThreadRootCommentId: inReplyToId ?? id,
    url: typeof rawComment.url === "string" ? rawComment.url : undefined,
  };
  return {
    ...base,
    action: readAction(base.raw),
    baseRef: readPullRequestBaseRef(pullRequest),
    baseSha: readPullRequestBaseSha(pullRequest),
    comment,
    conversation: {
      issueNumber: null,
      kind: "review_thread",
      pullRequestNumber,
    },
    defaultBranch: readPullRequestDefaultBranch(pullRequest),
    headRef: readPullRequestHeadRef(pullRequest),
    headSha: readPullRequestHeadSha(pullRequest),
    kind: "pull_request_review_comment",
  };
}

function parseIssueEvent(base: GitHubInboundEventBase): GitHubIssueWebhookEvent | null {
  const issue = isObject(base.raw.issue) ? base.raw.issue : null;
  const issueNumber = typeof issue?.number === "number" ? issue.number : undefined;
  if (issueNumber === undefined) return null;
  return {
    ...base,
    action: readAction(base.raw),
    conversation: {
      issueNumber,
      kind: "issue",
      pullRequestNumber: null,
    },
    issue: {
      action: readAction(base.raw),
      issueNumber,
      raw: parseJsonObject(issue),
    },
    kind: "issues",
  };
}

function parsePullRequestEvent(base: GitHubInboundEventBase): GitHubPullRequestWebhookEvent | null {
  const pullRequest = isObject(base.raw.pull_request) ? base.raw.pull_request : null;
  const pullRequestNumber =
    typeof pullRequest?.number === "number" ? pullRequest.number : undefined;
  if (pullRequestNumber === undefined) return null;
  return {
    ...base,
    action: readAction(base.raw),
    baseRef: readPullRequestBaseRef(pullRequest),
    baseSha: readPullRequestBaseSha(pullRequest),
    conversation: {
      issueNumber: null,
      kind: "pull_request",
      pullRequestNumber,
    },
    defaultBranch: readPullRequestDefaultBranch(pullRequest),
    headRef: readPullRequestHeadRef(pullRequest),
    headSha: readPullRequestHeadSha(pullRequest),
    kind: "pull_request",
    pullRequest: {
      action: readAction(base.raw),
      headSha: readPullRequestHeadSha(pullRequest),
      pullRequestNumber,
      raw: parseJsonObject(pullRequest),
    },
  };
}

function decodePayload(body: string, contentType: string | undefined): JsonObject {
  if (contentType?.includes("application/x-www-form-urlencoded") === true) {
    const payload = new URLSearchParams(body).get("payload") ?? "";
    return parseJsonObject(JSON.parse(payload) as unknown);
  }
  return parseJsonObject(JSON.parse(body) as unknown);
}

function normalizeRepository(value: unknown): GitHubRepositoryRef | null {
  if (!isObject(value)) return null;
  const fullName = typeof value.full_name === "string" ? value.full_name : "";
  const [fallbackOwner = "", fallbackName = ""] = fullName.split("/");
  const ownerObject = isObject(value.owner) ? value.owner : {};
  const owner = typeof ownerObject.login === "string" ? ownerObject.login : fallbackOwner;
  const name = typeof value.name === "string" ? value.name : fallbackName;
  const id = typeof value.id === "number" ? value.id : 0;
  if (!owner || !name) return null;
  return {
    fullName: fullName || `${owner}/${name}`,
    id,
    name,
    owner,
    private: value.private === true,
  };
}

function normalizeUser(value: unknown): GitHubUser | undefined {
  if (!isObject(value)) return undefined;
  const login = typeof value.login === "string" ? value.login : "";
  if (!login) return undefined;
  return {
    htmlUrl: typeof value.html_url === "string" ? value.html_url : undefined,
    id: typeof value.id === "number" ? value.id : 0,
    login,
    type: typeof value.type === "string" ? value.type : "User",
    url: typeof value.url === "string" ? value.url : undefined,
  };
}

function readInstallationId(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  return typeof value.id === "number" ? value.id : undefined;
}

function readAction(raw: JsonObject): string {
  return typeof raw.action === "string" ? raw.action : "";
}

function readPullRequestHeadSha(value: Record<string, unknown> | null): string | null {
  const head = isObject(value?.head) ? value.head : null;
  return typeof head?.sha === "string" ? head.sha : null;
}

function readPullRequestHeadRef(value: Record<string, unknown> | null): string | null {
  const head = isObject(value?.head) ? value.head : null;
  return typeof head?.ref === "string" ? head.ref : null;
}

function readPullRequestBaseRef(value: Record<string, unknown> | null): string | null {
  const base = isObject(value?.base) ? value.base : null;
  return typeof base?.ref === "string" ? base.ref : null;
}

function readPullRequestBaseSha(value: Record<string, unknown> | null): string | null {
  const base = isObject(value?.base) ? value.base : null;
  return typeof base?.sha === "string" ? base.sha : null;
}

function readPullRequestDefaultBranch(value: Record<string, unknown> | null): string | null {
  const base = isObject(value?.base) ? value.base : null;
  const repo = isObject(base?.repo) ? base.repo : null;
  return typeof repo?.default_branch === "string" ? repo.default_branch : null;
}

function isIgnoredGitHubComment(
  body: string,
  author: GitHubUser | undefined,
  botName: string | undefined,
): boolean {
  if (body.includes("<!-- eve:github:")) return true;
  if (author === undefined) return false;
  if (author.type === "Bot") return true;
  const botLogin = botName ? `${botName}[bot]`.toLowerCase() : "";
  return botLogin.length > 0 && author.login.toLowerCase() === botLogin;
}

function requiredNumber(value: number | null | undefined, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`githubContinuationToken requires ${name}.`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
