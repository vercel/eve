import type { TextPart, UserContent } from "ai";

import { isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type {
  GitHubAppRef,
  GitHubCheckRunWebhookEvent,
  GitHubCheckSuiteWebhookEvent,
  GitHubCiEvent,
  GitHubCommentTrigger,
  GitHubConversationKind,
  GitHubConversationRef,
  GitHubInboundEvent,
  GitHubInboundEventBase,
  GitHubIssueComment,
  GitHubIssueCommentEvent,
  GitHubIssueWebhookEvent,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewCommentEvent,
  GitHubPullRequestWebhookEvent,
  GitHubRepositoryRef,
  GitHubUser,
  GitHubWorkflowRunWebhookEvent,
} from "#public/channels/github/inbound-types.js";
export type {
  GitHubAppRef,
  GitHubCheckRunEvent,
  GitHubCheckRunWebhookEvent,
  GitHubCheckSuiteEvent,
  GitHubCheckSuiteWebhookEvent,
  GitHubCiEvent,
  GitHubCiPayload,
  GitHubCiWebhookEvent,
  GitHubComment,
  GitHubCommentTrigger,
  GitHubConversationKind,
  GitHubConversationRef,
  GitHubDelivery,
  GitHubInboundEvent,
  GitHubIssueAction,
  GitHubIssueComment,
  GitHubIssueCommentEvent,
  GitHubIssueEvent,
  GitHubIssueWebhookEvent,
  GitHubPullRequestAction,
  GitHubPullRequestEvent,
  GitHubPullRequestReviewComment,
  GitHubPullRequestReviewCommentEvent,
  GitHubPullRequestWebhookEvent,
  GitHubRepositoryRef,
  GitHubUser,
  GitHubWorkflowRunEvent,
  GitHubWorkflowRunWebhookEvent,
} from "#public/channels/github/inbound-types.js";

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
  const raw = decodePayload(input.body, input.contentType);
  const eventName = readHeader(input.headers, "x-github-event") ?? inferGitHubWebhookEventName(raw);
  if (eventName === null) return null;

  const repository = normalizeRepository(raw.repository);
  const sender = normalizeUser(raw.sender);
  if (repository === null || sender === undefined) return null;

  const base = {
    delivery: {
      event: eventName,
      hookId: readHeader(input.headers, "x-github-hook-id") ?? readGitHubHookId(raw),
      id: readHeader(input.headers, "x-github-delivery") ?? inferGitHubDeliveryId(eventName, raw),
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
  if (eventName === "check_suite") return parseCheckSuiteEvent(base);
  if (eventName === "check_run") return parseCheckRunEvent(base);
  if (eventName === "workflow_run") return parseWorkflowRunEvent(base);
  return null;
}

function inferGitHubWebhookEventName(raw: JsonObject): string | null {
  if (isObject(raw.hook) && typeof raw.zen === "string") return "ping";
  if (isObject(raw.comment) && isObject(raw.issue)) return "issue_comment";
  if (isObject(raw.comment) && isObject(raw.pull_request)) {
    return "pull_request_review_comment";
  }
  if (isObject(raw.check_suite)) return "check_suite";
  if (isObject(raw.check_run)) return "check_run";
  if (isObject(raw.workflow_run)) return "workflow_run";
  if (isObject(raw.issue)) return "issues";
  if (isObject(raw.pull_request) && !isObject(raw.review)) return "pull_request";
  return null;
}

function inferGitHubDeliveryId(eventName: string, raw: JsonObject): string {
  const id =
    readObjectNumber(raw.comment, "id") ??
    readObjectNumber(raw.issue, "id") ??
    readObjectNumber(raw.issue, "number") ??
    readObjectNumber(raw.pull_request, "id") ??
    readObjectNumber(raw.pull_request, "number") ??
    readObjectNumber(raw.check_suite, "id") ??
    readObjectNumber(raw.check_run, "id") ??
    readObjectNumber(raw.workflow_run, "id") ??
    readObjectNumber(raw.hook, "id") ??
    "unknown";
  const action = readAction(raw) || "unknown";
  return `inferred:${eventName}:${id}:${action}`;
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.trim();
  return value && value.length > 0 ? value : undefined;
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

function parseCheckSuiteEvent(base: GitHubInboundEventBase): GitHubCheckSuiteWebhookEvent | null {
  const rawCheckSuite = readEventObject(base.raw.check_suite);
  if (rawCheckSuite === null) return null;
  const checkSuiteId = readId(rawCheckSuite);
  if (checkSuiteId === null) return null;
  const checkSuite = normalizeCiEvent(base.raw, rawCheckSuite, normalizeApp(rawCheckSuite.app));
  return {
    ...base,
    checkSuite: { ...checkSuite, checkSuiteId },
    conversation: ciConversation(checkSuite.pullRequests),
    kind: "check_suite",
  };
}

function parseCheckRunEvent(base: GitHubInboundEventBase): GitHubCheckRunWebhookEvent | null {
  const rawCheckRun = readEventObject(base.raw.check_run);
  if (rawCheckRun === null) return null;
  const checkRunId = readId(rawCheckRun);
  if (checkRunId === null) return null;
  const checkRun = normalizeCiEvent(base.raw, rawCheckRun, normalizeApp(rawCheckRun.app));
  return {
    ...base,
    checkRun: { ...checkRun, checkRunId },
    conversation: ciConversation(checkRun.pullRequests),
    kind: "check_run",
  };
}

function parseWorkflowRunEvent(base: GitHubInboundEventBase): GitHubWorkflowRunWebhookEvent | null {
  const rawWorkflowRun = readEventObject(base.raw.workflow_run);
  if (rawWorkflowRun === null) return null;
  const workflowRunId = readId(rawWorkflowRun);
  if (workflowRunId === null) return null;
  const workflowRun = normalizeCiEvent(base.raw, rawWorkflowRun, { slug: "github-actions" });
  return {
    ...base,
    conversation: ciConversation(workflowRun.pullRequests),
    kind: "workflow_run",
    workflowRun: { ...workflowRun, workflowRunId },
  };
}

function normalizeCiEvent(webhook: JsonObject, raw: JsonObject, app: GitHubAppRef): GitHubCiEvent {
  return {
    action: readAction(webhook),
    app,
    conclusion: readNullableString(raw.conclusion),
    headSha: readNullableString(raw.head_sha),
    pullRequests: readPullRequestNumbers(raw.pull_requests),
    raw,
    status: readNullableString(raw.status),
  };
}

function readEventObject(value: unknown): JsonObject | null {
  return isObject(value) ? parseJsonObject(value) : null;
}

function readId(value: JsonObject): number | null {
  return typeof value.id === "number" ? value.id : null;
}

function readObjectNumber(value: unknown, key: string): number | null {
  return isObject(value) && typeof value[key] === "number" ? value[key] : null;
}

function normalizeApp(value: unknown): GitHubAppRef {
  return {
    slug: isObject(value) && typeof value.slug === "string" ? value.slug : null,
  };
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readPullRequestNumbers(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((pullRequest) =>
    isObject(pullRequest) && typeof pullRequest.number === "number" ? [pullRequest.number] : [],
  );
}

function ciConversation(pullRequests: readonly number[]): GitHubConversationRef {
  return {
    issueNumber: null,
    kind: "pull_request",
    pullRequestNumber: pullRequests[0] ?? null,
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

function readGitHubHookId(raw: JsonObject): string | undefined {
  if (typeof raw.hook_id === "number") return String(raw.hook_id);
  if (typeof raw.hook_id === "string" && raw.hook_id.length > 0) return raw.hook_id;
  const hookId = readObjectNumber(raw.hook, "id");
  return hookId === null ? undefined : String(hookId);
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
