import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/channel.js";

import { createLogger } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  buildGitHubBinding,
  type GitHubHandle,
  type GitHubThread,
} from "#public/channels/github/binding.js";
import { getGitHubRepository, type GitHubApiOptions } from "#public/channels/github/api.js";
import type { GitHubChannelCredentials } from "#public/channels/github/auth.js";
import { GITHUB_CHANNEL_DEFAULT_ROUTE } from "#public/channels/github/constants.js";
import { createDefaultEvents, defaultOnComment } from "#public/channels/github/defaults.js";
import {
  parseGitHubWebhookEvent,
  type GitHubCheckRunEvent,
  type GitHubCheckSuiteEvent,
  type GitHubComment,
  type GitHubConversationRef,
  type GitHubDelivery,
  type GitHubInboundEvent,
  type GitHubIssueEvent,
  type GitHubPullRequestEvent,
  type GitHubRepositoryRef,
  type GitHubUser,
  type GitHubWorkflowRunEvent,
} from "#public/channels/github/inbound.js";
import {
  dispatchCheckRun,
  dispatchCheckSuite,
  dispatchIssue,
  dispatchIssueComment,
  dispatchPullRequest,
  dispatchPullRequestReviewComment,
  dispatchWorkflowRun,
} from "#public/channels/github/dispatch.js";
import {
  continuationTokenFromState,
  conversationFromState,
  initialGitHubState,
  stateFromReceiveTarget,
  type GitHubChannelState,
} from "#public/channels/github/state.js";
import type { GitHubPullRequestContextConfig } from "#public/channels/github/pr-context.js";
import { verifyGitHubRequest } from "#public/channels/github/verify.js";
import { defineChannel, POST, type Channel } from "#public/definitions/channel.js";

const log = createLogger("github.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/**
 * Target accepted by `receive(github, { target })` for proactive sessions.
 * Requires `owner`, `repo`, and exactly one of `issueNumber` or
 * `pullRequestNumber`; supplying both numbers or neither throws.
 */
export interface GitHubReceiveTarget {
  readonly initialMessage?: string;
  readonly installationId?: number;
  readonly issueNumber?: number;
  readonly owner: string;
  readonly pullRequestNumber?: number;
  /** Optional shortcut that avoids a repository metadata API call. */
  readonly repositoryId?: number;
  readonly repo: string;
}

/** Optional acknowledgement progress surfaces for GitHub conversations. */
export interface GitHubProgressConfig {
  readonly reactions?: boolean;
}

/** Pre-dispatch GitHub context passed to inbound hooks. */
export interface GitHubInboundContext {
  readonly conversation: GitHubConversationRef;
  readonly delivery: GitHubDelivery;
  readonly github: GitHubHandle;
  readonly repository: GitHubRepositoryRef;
  readonly sender: GitHubUser;
  readonly thread: GitHubThread;
}

/** Channel-owned GitHub context rebuilt from persisted channel state. */
export interface GitHubChannelContext {
  readonly conversation: GitHubConversationRef;
  readonly github: GitHubHandle;
  readonly repository: GitHubRepositoryRef;
  readonly thread: GitHubThread;
  state: GitHubChannelState;
}

/** Event-handler GitHub context, including session operations. */
export interface GitHubEventContext extends GitHubChannelContext, ChannelSessionOps {}

/**
 * Result of a GitHub inbound hook. Return `null` to acknowledge without
 * dispatching; return `{ auth }` to dispatch. Optional `context` strings are
 * added as `role: "user"` messages before the dispatched turn.
 */
export type GitHubInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/**
 * Return type of GitHub inbound hooks: a {@link GitHubInboundResult} or a
 * promise for one.
 */
export type GitHubInboundResultOrPromise = GitHubInboundResult | Promise<GitHubInboundResult>;

type GitHubEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: GitHubEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type GitHubSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: GitHubEventContext,
) => void | Promise<void>;

/**
 * Event handlers for `githubChannel({ events })`. The channel installs built-in
 * handlers for `turn.started` (eyes reaction plus repo checkout),
 * `message.completed` (posts the reply), and `session.failed`/`turn.failed`
 * (posts an error comment). A handler supplied here replaces the built-in for
 * that key rather than running alongside it.
 */
export interface GitHubChannelEvents {
  readonly "action.result"?: GitHubEventHandler<"action.result">;
  readonly "actions.requested"?: GitHubEventHandler<"actions.requested">;
  readonly "authorization.completed"?: GitHubEventHandler<"authorization.completed">;
  readonly "authorization.required"?: GitHubEventHandler<"authorization.required">;
  readonly "input.requested"?: GitHubEventHandler<"input.requested">;
  readonly "message.appended"?: GitHubEventHandler<"message.appended">;
  readonly "message.completed"?: GitHubEventHandler<"message.completed">;
  readonly "session.completed"?: GitHubEventHandler<"session.completed">;
  readonly "session.failed"?: GitHubSessionFailedHandler;
  readonly "session.waiting"?: GitHubEventHandler<"session.waiting">;
  readonly "turn.completed"?: GitHubEventHandler<"turn.completed">;
  readonly "turn.cancelled"?: GitHubEventHandler<"turn.cancelled">;
  readonly "turn.failed"?: GitHubEventHandler<"turn.failed">;
  readonly "turn.started"?: GitHubEventHandler<"turn.started">;
}

/** Configuration for {@link githubChannel}. */
export interface GitHubChannelConfig {
  readonly api?: GitHubApiOptions;
  readonly botName?: string;
  readonly credentials?: GitHubChannelCredentials;
  readonly events?: GitHubChannelEvents;
  readonly progress?: GitHubProgressConfig;
  readonly pullRequestContext?: GitHubPullRequestContextConfig;
  readonly route?: string;

  /**
   * Invoked for every `@mention` of the bot in an issue/PR timeline comment or
   * an inline review comment; `ctx.conversation.kind` distinguishes the surface.
   * Return `{ auth }` to dispatch or `null` to ignore. Replaces the default
   * mention gate.
   */
  onComment?(ctx: GitHubInboundContext, comment: GitHubComment): GitHubInboundResultOrPromise;

  /**
   * Opt-in handler for `check_suite` webhook events. There is no default
   * dispatch. A dispatched turn is anchored to the first associated pull
   * request.
   */
  onCheckSuite?(
    ctx: GitHubInboundContext,
    checkSuite: GitHubCheckSuiteEvent,
  ): GitHubInboundResultOrPromise;

  /**
   * Opt-in handler for `check_run` webhook events. There is no default
   * dispatch. A dispatched turn is anchored to the first associated pull
   * request.
   */
  onCheckRun?(
    ctx: GitHubInboundContext,
    checkRun: GitHubCheckRunEvent,
  ): GitHubInboundResultOrPromise;

  /**
   * Opt-in handler for `issues` webhook events. There is no default dispatch;
   * define this to act on issues (e.g. `issue.action === "opened"`).
   */
  onIssue?(ctx: GitHubInboundContext, issue: GitHubIssueEvent): GitHubInboundResultOrPromise;

  /**
   * Opt-in handler for `pull_request` webhook events. There is no default
   * dispatch; define this to act on PRs (e.g. `pullRequest.action === "opened"`).
   */
  onPullRequest?(
    ctx: GitHubInboundContext,
    pullRequest: GitHubPullRequestEvent,
  ): GitHubInboundResultOrPromise;

  /**
   * Opt-in handler for `workflow_run` webhook events. There is no default
   * dispatch. A dispatched turn is anchored to the first associated pull
   * request.
   */
  onWorkflowRun?(
    ctx: GitHubInboundContext,
    workflowRun: GitHubWorkflowRunEvent,
  ): GitHubInboundResultOrPromise;
}

/** Concrete return type of {@link githubChannel}. */
export interface GitHubChannel extends Channel<GitHubChannelState, GitHubReceiveTarget> {}

/** GitHub channel factory for GitHub App webhooks and proactive comments. */
export function githubChannel(config: GitHubChannelConfig = {}): GitHubChannel {
  const botName = config.botName ?? process.env.GITHUB_APP_SLUG;
  const dispatchOptions = { botName };
  const mergedEvents: GitHubChannelEvents = {
    ...createDefaultEvents({
      api: config.api,
      credentials: config.credentials,
      progress: config.progress,
    }),
    ...config.events,
  };

  const channel = defineChannel<GitHubChannelState, GitHubChannelContext, GitHubReceiveTarget>({
    kindHint: "github",
    state: initialGitHubState(),

    context(state, session) {
      return rebuildGitHubContext(state, session, config);
    },

    routes: [
      POST<GitHubChannelState>(
        config.route ?? GITHUB_CHANNEL_DEFAULT_ROUTE,
        async (req, { send, waitUntil }) => {
          const body = await verifyInbound(req, config.credentials);
          if (body === null) return new Response("unauthorized", { status: 401 });
          const missingHeaders = missingGitHubWebhookHeaders(req.headers);

          let event: GitHubInboundEvent | null;
          try {
            event = parseGitHubWebhookEvent({
              body,
              contentType: req.headers.get("content-type") ?? undefined,
              headers: req.headers,
            });
          } catch (error) {
            log.warn("inbound GitHub body is not valid JSON", { error });
            return jsonOk({ ignored: true, ok: true });
          }

          if (event === null) {
            if (missingHeaders.length > 0) {
              log.warn("GitHub webhook ignored because standard headers were missing", {
                missingHeaders,
              });
            }
            return jsonOk({ ignored: true, ok: true });
          }
          if (missingHeaders.length > 0) {
            log.warn("GitHub webhook missing standard headers; inferred metadata from payload", {
              deliveryId: event.delivery.id,
              event: event.delivery.event,
              missingHeaders,
              repository: event.repository.fullName,
            });
          }
          if (event.kind === "ping") return jsonOk({ ok: true });

          if (event.kind === "issue_comment" && event.action === "created") {
            waitUntil(
              dispatchIssueComment({
                botName,
                config,
                event,
                handler:
                  config.onComment ??
                  ((ctx, comment) => defaultOnComment(ctx, comment, dispatchOptions)),
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "pull_request_review_comment" && event.action === "created") {
            waitUntil(
              dispatchPullRequestReviewComment({
                botName,
                config,
                event,
                handler:
                  config.onComment ??
                  ((ctx, comment) => defaultOnComment(ctx, comment, dispatchOptions)),
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "issues" && config.onIssue !== undefined) {
            waitUntil(
              dispatchIssue({
                config,
                event,
                handler: config.onIssue,
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "pull_request" && config.onPullRequest !== undefined) {
            waitUntil(
              dispatchPullRequest({
                config,
                event,
                handler: config.onPullRequest,
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "check_suite" && config.onCheckSuite !== undefined) {
            waitUntil(
              dispatchCheckSuite({
                config,
                event,
                handler: config.onCheckSuite,
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "check_run" && config.onCheckRun !== undefined) {
            waitUntil(
              dispatchCheckRun({
                config,
                event,
                handler: config.onCheckRun,
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          if (event.kind === "workflow_run" && config.onWorkflowRun !== undefined) {
            waitUntil(
              dispatchWorkflowRun({
                config,
                event,
                handler: config.onWorkflowRun,
                send,
              }),
            );
            return jsonOk({ ok: true });
          }

          return jsonOk({ ignored: true, ok: true });
        },
      ),
    ],

    async receive(input, { send }) {
      const target = input.target as Partial<GitHubReceiveTarget>;
      const owner = readNonEmptyString(target.owner);
      const repo = readNonEmptyString(target.repo);
      if (owner === undefined || repo === undefined) {
        throw new Error("githubChannel().receive requires target.owner and target.repo.");
      }

      const destinationCount = [
        target.issueNumber !== undefined,
        target.pullRequestNumber !== undefined,
      ].filter(Boolean).length;
      if (destinationCount !== 1) {
        throw new Error(
          "githubChannel().receive requires exactly one of issueNumber or pullRequestNumber.",
        );
      }

      const repositoryId =
        target.repositoryId ??
        (
          await getGitHubRepository({
            api: config.api,
            credentials: config.credentials,
            installationId: target.installationId,
            owner,
            repo,
          })
        ).id;

      const state = stateFromReceiveTarget({
        target,
        owner,
        repo,
        repositoryId,
      });

      if (target.initialMessage !== undefined) {
        const { thread } = buildGitHubBinding({ config, state });
        await thread.post(target.initialMessage);
      }

      return send(input.message, {
        auth: input.auth,
        continuationToken: continuationTokenFromState(state),
        state,
      });
    },

    events: mergedEvents,
  });

  return channel;
}

function rebuildGitHubContext(
  state: GitHubChannelState,
  _session: SessionHandle,
  config: GitHubChannelConfig,
): GitHubChannelContext {
  const binding = buildGitHubBinding({ config, state });
  return {
    conversation: conversationFromState(state),
    github: binding.github,
    repository: binding.github.repository,
    state,
    thread: binding.thread,
  };
}

async function verifyInbound(
  req: Request,
  credentials: GitHubChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifyGitHubRequest(req, {
      webhookSecret: credentials?.webhookSecret,
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("github inbound verification failed", { error });
    return null;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function missingGitHubWebhookHeaders(headers: Headers): readonly string[] {
  return ["x-github-event", "x-github-delivery"].filter((name) => {
    const value = headers.get(name);
    return value === null || value.trim().length === 0;
  });
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status: 200,
  });
}
