import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, logError } from "#internal/logging.js";
import { buildGitHubBinding } from "#public/channels/github/binding.js";
import {
  extractGitHubCommentTrigger,
  formatGitHubContextBlock,
  prependGitHubContext,
  type GitHubCheckRunWebhookEvent,
  type GitHubCheckSuiteWebhookEvent,
  type GitHubCiPayload,
  type GitHubCiWebhookEvent,
  type GitHubComment,
  type GitHubIssueComment,
  type GitHubIssueCommentEvent,
  type GitHubIssueWebhookEvent,
  type GitHubPullRequestReviewComment,
  type GitHubPullRequestReviewCommentEvent,
  type GitHubPullRequestWebhookEvent,
  type GitHubUser,
  type GitHubWorkflowRunWebhookEvent,
} from "#public/channels/github/inbound.js";
import {
  buildGitHubPullRequestContext,
  mergeGitHubContext,
} from "#public/channels/github/pr-context.js";
import {
  continuationTokenFromState,
  stateFromCiEvent,
  stateFromIssueCommentEvent,
  stateFromIssueEvent,
  stateFromPullRequestEvent,
  stateFromPullRequestReviewCommentEvent,
  type GitHubChannelState,
} from "#public/channels/github/state.js";
import type {
  GitHubChannelConfig,
  GitHubInboundContext,
  GitHubInboundResult,
  GitHubInboundResultOrPromise,
} from "#public/channels/github/githubChannel.js";
import type { SendFn } from "#public/definitions/channel.js";

const log = createLogger("github.dispatch");

type GitHubTurnEvent =
  | GitHubCiWebhookEvent
  | GitHubIssueCommentEvent
  | GitHubIssueWebhookEvent
  | GitHubPullRequestReviewCommentEvent
  | GitHubPullRequestWebhookEvent;

/** Dispatches a bot-directed issue or PR timeline comment into the runtime. */
export async function dispatchIssueComment(input: {
  readonly botName: string | undefined;
  readonly config: GitHubChannelConfig;
  readonly event: GitHubIssueCommentEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onComment"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  if (
    isIgnoredInboundComment(input.event.comment.body, input.event.comment.author, input.botName)
  ) {
    return;
  }
  const ctx = buildInboundContext(input.config, input.event);
  await dispatchCommentTurn({
    body: input.event.comment.body,
    botName: input.botName,
    commentUrl: input.event.comment.htmlUrl,
    event: input.event,
    handlerResult: () => input.handler(ctx, toGitHubComment(input.event.comment)),
    config: input.config,
    send: input.send,
    state: stateFromIssueCommentEvent(input.event),
  });
}

/** Dispatches a bot-directed inline pull-request review comment. */
export async function dispatchPullRequestReviewComment(input: {
  readonly botName: string | undefined;
  readonly config: GitHubChannelConfig;
  readonly event: GitHubPullRequestReviewCommentEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onComment"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  if (
    isIgnoredInboundComment(input.event.comment.body, input.event.comment.author, input.botName)
  ) {
    return;
  }
  const ctx = buildInboundContext(input.config, input.event);
  await dispatchCommentTurn({
    body: input.event.comment.body,
    botName: input.botName,
    commentUrl: input.event.comment.htmlUrl,
    event: input.event,
    handlerResult: () => input.handler(ctx, toGitHubComment(input.event.comment)),
    config: input.config,
    send: input.send,
    state: stateFromPullRequestReviewCommentEvent(input.event),
  });
}

/** Dispatches an opt-in issue webhook event into the runtime. */
export async function dispatchIssue(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubIssueWebhookEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onIssue"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  const ctx = buildInboundContext(input.config, input.event);
  await dispatchWebhookEventTurn({
    config: input.config,
    event: input.event,
    handlerResult: () => input.handler(ctx, input.event.issue),
    message: formatIssueEventMessage(input.event),
    send: input.send,
    state: stateFromIssueEvent(input.event),
  });
}

/** Dispatches an opt-in pull-request webhook event into the runtime. */
export async function dispatchPullRequest(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubPullRequestWebhookEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onPullRequest"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  const ctx = buildInboundContext(input.config, input.event);
  await dispatchWebhookEventTurn({
    config: input.config,
    event: input.event,
    handlerResult: () => input.handler(ctx, input.event.pullRequest),
    message: formatPullRequestEventMessage(input.event),
    send: input.send,
    state: stateFromPullRequestEvent(input.event),
  });
}

/** Dispatches an opt-in check-suite webhook event into the runtime. */
export async function dispatchCheckSuite(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubCheckSuiteWebhookEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onCheckSuite"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  await dispatchCiEvent({
    ...input,
    ci: input.event.checkSuite,
    handlerResult: (ctx) => input.handler(ctx, input.event.checkSuite),
    label: "Check suite",
  });
}

/** Dispatches an opt-in check-run webhook event into the runtime. */
export async function dispatchCheckRun(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubCheckRunWebhookEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onCheckRun"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  await dispatchCiEvent({
    ...input,
    ci: input.event.checkRun,
    handlerResult: (ctx) => input.handler(ctx, input.event.checkRun),
    label: "Check run",
  });
}

/** Dispatches an opt-in workflow-run webhook event into the runtime. */
export async function dispatchWorkflowRun(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubWorkflowRunWebhookEvent;
  readonly handler: NonNullable<GitHubChannelConfig["onWorkflowRun"]>;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  await dispatchCiEvent({
    ...input,
    ci: input.event.workflowRun,
    handlerResult: (ctx) => input.handler(ctx, input.event.workflowRun),
    label: "Workflow run",
  });
}

async function dispatchCiEvent(input: {
  readonly ci: GitHubCiPayload;
  readonly config: GitHubChannelConfig;
  readonly event: GitHubCiWebhookEvent;
  readonly handlerResult: (ctx: GitHubInboundContext) => GitHubInboundResultOrPromise;
  readonly label: string;
  readonly send: SendFn<GitHubChannelState>;
}): Promise<void> {
  const state = stateFromCiEvent(input.event);
  const ctx = buildInboundContext(input.config, input.event);
  if (state.pullRequestNumber === null) {
    const result = await runInboundHandler({
      event: input.event,
      handlerResult: () => input.handlerResult(ctx),
    });
    if (result !== null && result !== undefined) {
      log.warn("GitHub CI event cannot dispatch without an associated pull request", {
        deliveryId: input.event.delivery.id,
        event: input.event.kind,
      });
    }
    return;
  }

  await dispatchWebhookEventTurn({
    config: input.config,
    event: input.event,
    handlerResult: () => input.handlerResult(ctx),
    message: formatCiEventMessage(input.label, input.ci),
    send: input.send,
    state,
  });
}

async function dispatchWebhookEventTurn(input: {
  readonly config: GitHubChannelConfig;
  readonly event: GitHubCiWebhookEvent | GitHubIssueWebhookEvent | GitHubPullRequestWebhookEvent;
  readonly handlerResult: () => GitHubInboundResultOrPromise;
  readonly message: string;
  readonly send: SendFn<GitHubChannelState>;
  readonly state: GitHubChannelState;
}): Promise<void> {
  const result = await runInboundHandler({
    event: input.event,
    handlerResult: input.handlerResult,
  });
  if (result === null || result === undefined) return;

  await sendGitHubTurn({
    auth: result.auth,
    event: input.event,
    message: input.message,
    context: mergeGitHubContext({
      github: await buildPullRequestContext(input.config, input.state, input.event.delivery.id),
      hook: result.context,
    }),
    send: input.send,
    state: input.state,
  });
}

async function dispatchCommentTurn(input: {
  readonly body: string;
  readonly botName: string | undefined;
  readonly commentUrl: string | undefined;
  readonly config: GitHubChannelConfig;
  readonly event: GitHubIssueCommentEvent | GitHubPullRequestReviewCommentEvent;
  readonly handlerResult: () => GitHubInboundResultOrPromise;
  readonly send: SendFn<GitHubChannelState>;
  readonly state: GitHubChannelState;
}): Promise<void> {
  const result = await runInboundHandler({
    event: input.event,
    handlerResult: input.handlerResult,
  });
  if (result === null || result === undefined) return;

  const trigger = extractGitHubCommentTrigger({
    body: input.body,
    botName: input.botName,
  });
  const message = trigger?.message ?? input.body.trim();

  await sendGitHubTurn({
    auth: result.auth,
    commentUrl: input.commentUrl,
    event: input.event,
    message,
    context: mergeGitHubContext({
      github: await buildPullRequestContext(input.config, input.state, input.event.delivery.id),
      hook: result.context,
    }),
    send: input.send,
    state: input.state,
  });
}

async function runInboundHandler(input: {
  readonly event: GitHubTurnEvent;
  readonly handlerResult: () => GitHubInboundResultOrPromise;
}): Promise<GitHubInboundResult | undefined> {
  try {
    return await input.handlerResult();
  } catch (error) {
    logError(log, "GitHub inbound handler failed", error, {
      deliveryId: input.event.delivery.id,
    });
    return undefined;
  }
}

async function sendGitHubTurn(input: {
  readonly auth: SessionAuthContext | null;
  readonly commentUrl?: string;
  readonly event: GitHubTurnEvent;
  readonly logMessage?: string;
  readonly message: string;
  readonly context: readonly string[] | undefined;
  readonly send: SendFn<GitHubChannelState>;
  readonly state: GitHubChannelState;
}): Promise<void> {
  const contextBlock = formatGitHubContextBlock({
    deliveryId: input.event.delivery.id,
    commentUrl: input.commentUrl,
    headSha: input.state.headSha,
    issueNumber: input.state.issueNumber,
    pullRequestNumber: input.state.pullRequestNumber,
    repository: input.event.repository,
    sender: input.event.sender,
  });
  const turnMessage = prependGitHubContext(input.message, contextBlock);

  try {
    await input.send(
      {
        message: turnMessage,
        context: input.context,
      },
      {
        auth: input.auth,
        continuationToken: continuationTokenFromState(input.state),
        state: input.state,
      },
    );
  } catch (error) {
    logError(log, input.logMessage ?? "GitHub delivery failed", error, {
      deliveryId: input.event.delivery.id,
    });
  }
}

async function buildPullRequestContext(
  config: GitHubChannelConfig,
  state: GitHubChannelState,
  deliveryId: string,
): Promise<readonly string[] | undefined> {
  try {
    return await buildGitHubPullRequestContext({
      api: config.api,
      baseSha: state.baseSha,
      config: config.pullRequestContext,
      credentials: config.credentials,
      headSha: state.headSha,
      installationId: state.installationId ?? undefined,
      owner: state.owner,
      pullRequestNumber: state.pullRequestNumber,
      repo: state.repo,
    });
  } catch (error) {
    logError(log, "GitHub pull-request context failed — swallowed", error, { deliveryId });
    return undefined;
  }
}

function buildInboundContext(
  config: GitHubChannelConfig,
  event:
    | GitHubCiWebhookEvent
    | GitHubIssueCommentEvent
    | GitHubIssueWebhookEvent
    | GitHubPullRequestWebhookEvent
    | GitHubPullRequestReviewCommentEvent,
): GitHubInboundContext {
  const state =
    event.kind === "check_suite" || event.kind === "check_run" || event.kind === "workflow_run"
      ? stateFromCiEvent(event)
      : event.kind === "issue_comment"
        ? stateFromIssueCommentEvent(event)
        : event.kind === "issues"
          ? stateFromIssueEvent(event)
          : event.kind === "pull_request"
            ? stateFromPullRequestEvent(event)
            : stateFromPullRequestReviewCommentEvent(event);
  const binding = buildGitHubBinding({ config, state });
  return {
    conversation: event.conversation,
    delivery: event.delivery,
    github: binding.github,
    repository: event.repository,
    sender: event.sender,
    thread: binding.thread,
  };
}

function toGitHubComment(
  comment: GitHubIssueComment | GitHubPullRequestReviewComment,
): GitHubComment {
  return {
    author: comment.author,
    body: comment.body,
    htmlUrl: comment.htmlUrl,
    id: comment.id,
    raw: comment.raw,
    url: comment.url,
  };
}

function formatIssueEventMessage(event: GitHubIssueWebhookEvent): string {
  const title = readString(event.issue.raw.title);
  return `Issue ${event.issue.action}: #${event.issue.issueNumber}${title ? ` ${title}` : ""}`;
}

function formatPullRequestEventMessage(event: GitHubPullRequestWebhookEvent): string {
  const title = readString(event.pullRequest.raw.title);
  return `Pull request ${event.pullRequest.action}: #${event.pullRequest.pullRequestNumber}${
    title ? ` ${title}` : ""
  }`;
}

function formatCiEventMessage(label: string, event: GitHubCiPayload): string {
  const outcome = event.conclusion ?? event.status;
  return `${label} ${event.action}: ${ciEventId(event)}${outcome ? ` (${outcome})` : ""}`;
}

function ciEventId(event: GitHubCiPayload): number {
  if ("checkSuiteId" in event) return event.checkSuiteId;
  if ("checkRunId" in event) return event.checkRunId;
  return event.workflowRunId;
}

function isIgnoredInboundComment(
  body: string,
  author: GitHubUser | undefined,
  botName: string | undefined,
): boolean {
  if (body.includes("<!-- eve:github:")) return true;
  if (author?.type === "Bot") return true;
  const botLogin = botName ? `${botName}[bot]`.toLowerCase() : "";
  return botLogin.length > 0 && author?.login.toLowerCase() === botLogin;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
