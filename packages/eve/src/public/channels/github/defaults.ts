import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint, logError } from "#internal/logging.js";
import type { GitHubApiOptions } from "#public/channels/github/api.js";
import type { GitHubChannelCredentials } from "#public/channels/github/auth.js";
import { checkoutGitHubRepository } from "#public/channels/github/checkout.js";
import {
  shouldDispatchGitHubComment,
  type GitHubComment,
} from "#public/channels/github/inbound.js";
import type {
  GitHubChannelEvents,
  GitHubInboundContext,
  GitHubInboundResult,
  GitHubProgressConfig,
} from "#public/channels/github/githubChannel.js";
import { splitGitHubCommentBody } from "#public/channels/github/limits.js";
import type { SessionContext } from "#public/definitions/callback-context.js";

const log = createLogger("github.defaults");

/**
 * Projects a GitHub webhook actor into an eve {@link SessionAuthContext}. Sets `principalId` to
 * `github:<sender.id>`, `principalType` to `"service"` for bot senders and `"user"` otherwise, and
 * copies conversation and repository metadata into `attributes`. Reuse it when composing a custom
 * `onComment` hook.
 */
export function defaultGitHubAuth(ctx: GitHubInboundContext): SessionAuthContext {
  const { sender } = ctx;
  return {
    attributes: {
      conversation_kind: ctx.conversation.kind,
      delivery_id: ctx.delivery.id,
      installation_id: String(ctx.github.installationId ?? ""),
      issue_number: String(ctx.conversation.issueNumber ?? ""),
      pull_request_number: String(ctx.conversation.pullRequestNumber ?? ""),
      repository: ctx.repository.fullName,
      repository_id: String(ctx.repository.id),
      user_login: sender.login,
      user_type: sender.type,
    },
    authenticator: "github-webhook",
    issuer: `github:${ctx.repository.owner}`,
    principalId: `github:${sender.id}`,
    principalType: sender.type === "Bot" ? "service" : "user",
    subject: sender.login,
  };
}

/** Options used by the built-in GitHub comment dispatch hook. */
export interface GitHubDefaultDispatchOptions {
  readonly botName?: string;
}

/** Default comment hook: dispatch only when the comment `@mention`s the bot. */
export function defaultOnComment(
  ctx: GitHubInboundContext,
  comment: GitHubComment,
  options: GitHubDefaultDispatchOptions,
): GitHubInboundResult {
  if (
    !shouldDispatchGitHubComment({
      author: comment.author,
      body: comment.body,
      botName: options.botName,
    })
  ) {
    return null;
  }
  return { auth: defaultGitHubAuth(ctx) };
}

/** Options used by built-in GitHub event handlers. */
export interface GitHubDefaultEventOptions {
  readonly api?: GitHubApiOptions;
  readonly credentials?: GitHubChannelCredentials;
  readonly progress?: GitHubProgressConfig;
}

/** Builds GitHub's built-in event handlers for acknowledgement and terminal output. */
export function createDefaultEvents(options: GitHubDefaultEventOptions = {}): GitHubChannelEvents {
  return {
    async "turn.started"(_event, channel, ctx) {
      if (options.progress?.reactions !== false) {
        try {
          await channel.thread.react("eyes");
        } catch (error) {
          logError(log, "GitHub reaction failed — swallowed", error);
        }
      }

      await checkoutRepositoryForTurn(channel, ctx, options);
    },

    async "message.completed"(event, channel, _ctx) {
      if (event.finishReason === "tool-calls" || !event.message) return;
      await postCommentChunks(channel, event.message);
    },

    async "session.failed"(event, channel) {
      const hint = formatErrorHint(event);
      const errorId = extractErrorId(event.details);
      const message = [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new comment to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n");
      await postFailure(channel, message);
    },

    async "turn.failed"(event, channel, _ctx) {
      const hint = formatErrorHint(event);
      const errorId = extractErrorId(event.details);
      const message = [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n");
      await postFailure(channel, message);
    },
  };
}

async function checkoutRepositoryForTurn(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1],
  ctx: SessionContext,
  options: GitHubDefaultEventOptions,
): Promise<void> {
  const { state } = channel;
  try {
    const sandbox = await ctx.getSandbox();
    const checkout = await checkoutGitHubRepository(sandbox, {
      api: options.api,
      baseRef: state.baseRef,
      baseSha: state.baseSha,
      credentials: options.credentials,
      defaultBranch: state.defaultBranch,
      headRef: state.headRef,
      headSha: state.headSha,
      includeBase: state.pullRequestNumber !== null,
      installationId: state.installationId,
      owner: state.owner,
      pullRequestNumber: state.pullRequestNumber,
      repo: state.repo,
    });
    state.checkoutPath = checkout.path;
    state.headSha = checkout.sha;
    state.baseRef = checkout.baseRef;
  } catch (error) {
    logError(log, "GitHub checkout failed — swallowed", error);
  }
}

async function postCommentChunks(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1],
  body: string,
): Promise<void> {
  for (const chunk of splitGitHubCommentBody(body)) {
    await channel.thread.post(chunk);
  }
}

async function postFailure(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1],
  message: string,
): Promise<void> {
  await postCommentChunks(channel, message);
}
