import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import { buildSlackAuthContext, slackUserIdFromAuthContext } from "#public/channels/slack/auth.js";
import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthRequiredPublicText,
  formatConnectionDisplayName,
  type ConnectionAuthorizationOutcome,
} from "#public/channels/slack/connections.js";
import {
  formatInputRequestFallbackText,
  renderInputRequestBlocks,
} from "#public/channels/slack/hitl.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import {
  SLACK_MAX_BLOCKS_PER_MESSAGE,
  truncateMessageText,
  truncateTypingStatus,
} from "#public/channels/slack/limits.js";
import type {
  SlackChannelEvents,
  SlackChannelInternalEvents,
  SlackContext,
  SlackMentionResult,
} from "#public/channels/slack/slackChannel.js";
import type { InputRequest } from "#runtime/input/types.js";

const log = createLogger("slack.defaults");
const REASONING_TYPING_REFRESH_INTERVAL_MS = 5_000;
const REASONING_TYPING_MIN_PROGRESS_CHARS = 4;

/**
 * Workspace-scoped projection of the Slack actor that produced
 * `message`, derived into a {@link SessionAuthContext}. Used by both
 * {@link defaultOnAppMention} and {@link defaultOnDirectMessage} when
 * the customer hasn't supplied their own `onAppMention` /
 * `onDirectMessage`. Returns `null` when the message has no author.
 */
export function defaultSlackAuth(
  message: SlackMessage,
  ctx: SlackContext,
): SessionAuthContext | null {
  const author = message.author;
  if (!author) return null;

  return buildSlackAuthContext({
    channelId: ctx.slack.channelId,
    fullName: author.fullName,
    isBot: author.isBot,
    teamId: message.teamId,
    threadTs: ctx.slack.threadTs,
    userId: author.userId,
    userName: author.userName,
  });
}

/**
 * Default `onAppMention` — derives auth from the Slack actor and posts
 * a `"Thinking…"` typing indicator before the workflow runtime starts.
 */
export async function defaultOnAppMention(
  ctx: SlackContext,
  message: SlackMessage,
): Promise<SlackMentionResult> {
  await ctx.thread.startTyping("Thinking...");
  return { auth: defaultSlackAuth(message, ctx) };
}

/**
 * Default `onDirectMessage` — derives auth from the Slack actor and
 * posts a `"Thinking…"` typing indicator before the workflow runtime
 * starts. Matches the default mention behavior; replace the option to
 * customize gating, auth derivation, or pre-dispatch side effects.
 */
export async function defaultOnDirectMessage(
  ctx: SlackContext,
  message: SlackMessage,
): Promise<SlackMentionResult> {
  await ctx.thread.startTyping("Thinking...");
  return { auth: defaultSlackAuth(message, ctx) };
}

/**
 * Reads the first non-empty line of a model-emitted message. The
 * default `actions.requested` handler uses this to surface the
 * model's own pre-tool-call narration as the typing indicator.
 */
function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Default `input.requested` handler — renders each pending HITL
 * request as Slack `block_actions`. Buttons by default; radio for
 * ≤6-option select requests; static_select for >6-option select
 * requests. Batches split into multiple posts when they would exceed
 * Slack's 50-block message cap. Override by declaring
 * `events["input.requested"]`.
 */
export function defaultInputRequestedHandler(): NonNullable<SlackChannelEvents["input.requested"]> {
  return async (data, channel, _ctx) => {
    for (const post of buildInputRequestPosts(data.requests)) {
      await channel.thread.post(post);
    }
  };
}

/**
 * Groups HITL requests into `chat.postMessage` payloads that stay under
 * Slack's block-count cap. A request's blocks never split across posts,
 * so its buttons always land in the same message as its prompt.
 */
function buildInputRequestPosts(
  requests: readonly InputRequest[],
): Array<{ blocks: unknown[]; text: string }> {
  const groups: Array<{ blocks: unknown[]; fallbacks: string[] }> = [];
  for (const request of requests) {
    const blocks = renderInputRequestBlocks(request);
    const current = groups.at(-1);
    if (current && current.blocks.length + blocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE) {
      current.blocks.push(...blocks);
      current.fallbacks.push(formatInputRequestFallbackText(request));
    } else {
      groups.push({ blocks, fallbacks: [formatInputRequestFallbackText(request)] });
    }
  }
  return groups.map((group) => ({
    blocks: group.blocks,
    text: truncateMessageText(group.fallbacks.join("\n")),
  }));
}

/**
 * Built-in Slack event handlers — typing indicators, error replies,
 * and the connection-authorization status flow. Each is overridable
 * per-event by passing the same key under `slackChannel({ events })`.
 * Typed as the internal full-context map because the default
 * `authorization.required` handler owns the public link-free status,
 * which user overrides cannot express.
 */
export const defaultEvents: SlackChannelInternalEvents = {
  async "turn.started"(_event, channel, _ctx) {
    channel.state.pendingToolCallMessage = null;
    channel.state.lastReasoningTypingAtMs = null;
    channel.state.lastReasoningTypingStatus = null;
    await channel.thread.startTyping("Working...");
  },

  async "reasoning.appended"(event, channel, _ctx) {
    const line = firstNonEmptyLine(event.reasoningSoFar);
    if (line === undefined) return;

    const status = truncateTypingStatus(line);
    const lastStatus = channel.state.lastReasoningTypingStatus;
    const isProgressiveExtension =
      lastStatus !== null &&
      lastStatus !== undefined &&
      status.startsWith(lastStatus) &&
      status.length >= lastStatus.length + REASONING_TYPING_MIN_PROGRESS_CHARS;
    const now = Date.now();
    const lastAt = channel.state.lastReasoningTypingAtMs;
    if (!isProgressiveExtension && lastAt !== null && lastAt !== undefined) {
      const elapsed = now - lastAt;
      if (elapsed >= 0 && elapsed < REASONING_TYPING_REFRESH_INTERVAL_MS) return;
    }

    await channel.thread.startTyping(status);
    channel.state.lastReasoningTypingAtMs = now;
    channel.state.lastReasoningTypingStatus = status;
  },

  async "actions.requested"(event, channel, _ctx) {
    const buffered = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    if (buffered) {
      await channel.thread.startTyping(truncateTypingStatus(buffered));
      return;
    }
    const labels = event.actions.map((a) => (a.kind === "tool-call" ? a.toolName : a.kind));
    await channel.thread.startTyping(truncateTypingStatus(`Running ${labels.join(", ")}...`));
  },

  async "message.completed"(event, channel, _ctx) {
    if (event.finishReason === "tool-calls") {
      channel.state.pendingToolCallMessage = event.message
        ? (firstNonEmptyLine(event.message) ?? null)
        : null;
      return;
    }
    channel.state.pendingToolCallMessage = null;
    if (!event.message) {
      await channel.thread.startTyping();
      return;
    }
    await channel.thread.post(event.message);
  },

  async "turn.failed"(event, channel, _ctx) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.thread.post(
      [
        `I hit an error while handling your request${hint}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "session.failed"(event, channel) {
    const hint = formatErrorHint(event);
    const errorId = extractErrorId(event.details);
    await channel.thread.post(
      [
        `This session couldn't recover from an error${hint}.`,
        "",
        "Start a new thread to continue — I can't pick this one back up.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "authorization.required"(event, channel, ctx) {
    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    const triggeringUserId =
      slackUserIdFromAuthContext(ctx.session.auth.current) ??
      channel.state.triggeringUserId ??
      null;
    const challengeUrl = event.authorization?.url;

    // Post a public, link-free status so everyone in the thread can see
    // the session is blocked and later see it complete. The challenge
    // itself remains private.
    const pending = channel.state.pendingAuthMessageTs ?? {};
    if (pending[event.name] === undefined) {
      const publicText = buildAuthRequiredPublicText({
        displayName,
        hasUser: triggeringUserId !== null,
      });
      try {
        const sent = await channel.thread.post(publicText);
        if (sent.id) {
          channel.state.pendingAuthMessageTs = {
            ...pending,
            [event.name]: sent.id,
          };
        }
      } catch (error) {
        log.error("Slack auth public message delivery failed", {
          name: event.name,
          error,
        });
      }
    }

    // The challenge is user-specific: the sign-in link (and device code)
    // must only ever be visible to the triggering user, never posted into
    // the shared thread.
    if (triggeringUserId && challengeUrl) {
      const userCode = event.authorization?.userCode;
      try {
        await channel.thread.postEphemeral(triggeringUserId, {
          blocks: buildAuthEphemeralBlocks({
            displayName,
            url: challengeUrl,
            userCode,
          }),
          // Fallback text mirrors the blocks: clients that render only the
          // notification text still get everything needed to complete the flow.
          text: userCode
            ? `Sign in with ${displayName}: ${challengeUrl} (code: ${userCode})`
            : `Sign in with ${displayName}: ${challengeUrl}`,
        });
      } catch (error) {
        log.error("Slack auth ephemeral delivery failed", {
          name: event.name,
          error,
        });
      }
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    const pending = channel.state.pendingAuthMessageTs ?? {};
    const ts = pending[event.name];
    if (ts === undefined) return;

    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    const text = buildAuthCompletedText({
      displayName,
      outcome: event.outcome as ConnectionAuthorizationOutcome,
      reason: event.reason,
    });

    try {
      await channel.slack.request("chat.update", {
        channel: channel.slack.channelId,
        ts,
        text,
      });
    } catch (error) {
      log.error("Slack auth status edit failed", {
        name: event.name,
        error,
      });
    }

    const next = { ...pending };
    delete next[event.name];
    channel.state.pendingAuthMessageTs = next;
  },
};
