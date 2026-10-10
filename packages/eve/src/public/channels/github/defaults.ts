import { errorHintOf, replyTextOf } from "#public/channels/reply.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};
import { promptQueueEvents } from "#channel/prompt-queue.js";
import { renderTextInputRequest } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, formatErrorHint, logError } from "#internal/logging.js";
import type { GitHubApiOptions } from "#public/channels/github/api.js";
import type {
  GitHubBotNameResolver,
  GitHubChannelCredentials,
} from "#public/channels/github/auth.js";
import { checkoutGitHubRepository } from "#public/channels/github/checkout.js";
import {
  shouldDispatchGitHubComment,
  type GitHubComment,
} from "#public/channels/github/inbound.js";
import type {
  GitHubChannelEvents,
  GitHubEventContext,
  GitHubInboundContext,
  GitHubInboundResult,
  GitHubProgressConfig,
} from "#public/channels/github/githubChannel.js";
import { splitGitHubCommentBody } from "#public/channels/github/limits.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import type { InputRequest } from "#shared/input.js";

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
interface GitHubDefaultDispatchOptions {
  readonly botName?: GitHubBotNameResolver;
}

/** Default comment hook: dispatch only when the comment `@mention`s the bot. */
export async function defaultOnComment(
  ctx: GitHubInboundContext,
  comment: GitHubComment,
  options: GitHubDefaultDispatchOptions,
): Promise<GitHubInboundResult> {
  if (
    !shouldDispatchGitHubComment({
      author: comment.author,
      body: comment.body,
      botName: await options.botName?.(),
    })
  ) {
    return null;
  }
  return { auth: defaultGitHubAuth(ctx) };
}

/** Options used by built-in GitHub event handlers. */
interface GitHubDefaultEventOptions {
  readonly api?: GitHubApiOptions;
  readonly botName?: GitHubBotNameResolver;
  readonly credentials?: GitHubChannelCredentials;
  readonly progress?: GitHubProgressConfig;
}

/** Builds GitHub's built-in event handlers for acknowledgement and terminal output. */
export function createDefaultEvents(options: GitHubDefaultEventOptions = {}): GitHubChannelEvents {
  async function showPrompt(channel: GitHubEventContext, request: InputRequest): Promise<void> {
    const sections = [renderInputRequest(request)];
    const replyInstruction = renderReplyInstruction(request, await options.botName?.());
    if (replyInstruction !== undefined) sections.push(replyInstruction);
    await postCommentChunks(channel, sections.join("\n\n"));
  }

  return {
    async "turn.started"(_event, ctx) {
      const { channel } = ctx;
      if (options.progress?.reactions !== false) {
        try {
          await channel.thread.react("eyes");
        } catch (error) {
          logError(log, "GitHub reaction failed — swallowed", error);
        }
      }

      await checkoutRepositoryForTurn(channel, ctx, options);
    },

    async "content.completed"({ data }, { channel }) {
      const text = replyTextOf(data);
      if (text === undefined) return;
      await postCommentChunks(channel, text);
    },

    // A comment can only answer the prompt it sees, so prompts post one at a time.
    ...promptQueueEvents(showPrompt),

    async "session.ended"({ data }, { channel }) {
      if (data.outcome !== "failed") return;
      const hint = formatErrorHint(errorHintOf(data.error));
      const errorId = data.error?.id;
      const message = [
        `This session could not recover from an error${hint}.`,
        "",
        "Start a new comment to continue.",
        ...(errorId ? ["", `Error id: ${errorId}`] : []),
      ].join("\n");
      await postFailure(channel, message);
    },

    async "turn.settled"({ data }, { channel }) {
      if (data.outcome !== "failed") return;
      const hint = formatErrorHint(errorHintOf(data.error));
      const errorId = data.error?.id;
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

function renderInputRequest(request: InputRequest): string {
  const body = renderTextInputRequest(request);
  return request.allowFreeform === true
    ? `${body}\n\nYou can also reply with a custom answer.`
    : body;
}

// The default onComment hook only dispatches comments that @mention the bot,
// so a prompt without this instruction invites replies that are silently ignored.
function renderReplyInstruction(
  request: InputRequest,
  botName: string | undefined,
): string | undefined {
  const name = botName?.trim();
  if (!name) return undefined;
  const example = request.options?.[0]?.label ?? "<your answer>";
  return `Answer by mentioning me in a reply, e.g. \`@${name} ${example}\`.`;
}

async function checkoutRepositoryForTurn(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1]["channel"],
  ctx: SessionContext,
  options: GitHubDefaultEventOptions,
): Promise<void> {
  const { state } = channel;
  try {
    const sandbox = await ctx.getSandbox();
    if (!("setNetworkPolicy" in sandbox)) {
      throw new Error("GitHub checkout requires a sandbox provider with mutable network policy.");
    }
    const checkout = await checkoutGitHubRepository(
      sandbox as RuntimeSandboxSession & NetworkPolicySandboxSession,
      {
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
      },
    );
    state.checkoutPath = checkout.path;
    state.headSha = checkout.sha;
    state.baseRef = checkout.baseRef;
  } catch (error) {
    logError(log, "GitHub checkout failed — swallowed", error);
  }
}

async function postCommentChunks(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1]["channel"],
  body: string,
): Promise<void> {
  for (const chunk of splitGitHubCommentBody(body)) {
    await channel.thread.post(chunk);
  }
}

async function postFailure(
  channel: Parameters<NonNullable<GitHubChannelEvents["turn.started"]>>[1]["channel"],
  message: string,
): Promise<void> {
  await postCommentChunks(channel, message);
}
