import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import { describeActionRequests } from "#public/channels/slack/action-status.js";
import { buildSlackAuthContext, slackUserIdFromAuthContext } from "#public/channels/slack/auth.js";
import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthRequiredPublicText,
  formatConnectionDisplayName,
  type ConnectionAuthorizationOutcome,
} from "#public/channels/slack/connections.js";
import {
  buildAnsweredBlocks,
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

function blockContainsRequestAction(block: unknown, requestId: string): boolean {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as { actions?: unknown; elements?: unknown };
  const requestActionPrefix = `eve_input:${requestId}`;
  return [candidate.actions, candidate.elements].some(
    (entries) =>
      Array.isArray(entries) &&
      entries.some((entry) => {
        if (typeof entry !== "object" || entry === null) return false;
        const actionId = (entry as { action_id?: unknown }).action_id;
        return typeof actionId === "string" && actionId.startsWith(requestActionPrefix);
      }),
  );
}

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
      const message = await channel.thread.post({ blocks: post.blocks, text: post.text });
      if (!message.id) continue;
      const cards = { ...channel.state.pendingApprovalCards };
      for (const request of post.requests) {
        if (request.kind === "tool-approval") {
          cards[request.requestId] = {
            messageBlocks: post.blocks,
            messageTs: message.id,
          };
        }
      }
      channel.state.pendingApprovalCards = cards;
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
): Array<{ blocks: unknown[]; requests: InputRequest[]; text: string }> {
  const groups: Array<{ blocks: unknown[]; fallbacks: string[]; requests: InputRequest[] }> = [];
  for (const request of requests) {
    const blocks = renderInputRequestBlocks(request);
    const current = groups.at(-1);
    if (current && current.blocks.length + blocks.length <= SLACK_MAX_BLOCKS_PER_MESSAGE) {
      current.blocks.push(...blocks);
      current.fallbacks.push(formatInputRequestFallbackText(request));
      current.requests.push(request);
    } else {
      groups.push({
        blocks,
        fallbacks: [formatInputRequestFallbackText(request)],
        requests: [request],
      });
    }
  }
  return groups.map((group) => ({
    blocks: group.blocks,
    requests: group.requests,
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
  async "approval.candidate"(event, channel, _ctx) {
    const userId = channel.state.pendingApprovalCandidateUsers?.[event.candidateId];
    if (event.outcome === "pending" && userId !== undefined) {
      await channel.thread.postEphemeral(userId, "Checking whether you can approve this action…");
      return;
    }
    if (userId === undefined) return;
    if (event.outcome === "rejected" || event.outcome === "failed") {
      await channel.thread.postEphemeral(
        userId,
        event.safeReason ?? "We couldn’t verify your approval. Please try again.",
      );
    }
  },

  async "approval.settled"(event, channel, _ctx) {
    const cards = channel.state.pendingApprovalCards ?? {};
    const card = cards[event.requestId];
    if (card === undefined || channel.state.channelId === null) return;
    const answerLabel = event.outcome === "approved" ? "Approve" : "Cancel";
    const blocks = card.messageBlocks.flatMap((block) => {
      if (!blockContainsRequestAction(block, event.requestId)) return [block];
      if (typeof block !== "object" || block === null) return [];
      const candidate = block as Record<string, unknown>;
      if (candidate.type !== "card") {
        return buildAnsweredBlocks({ answerLabel, promptBlocks: [], userId: card.userId });
      }
      const { actions: _actions, ...withoutActions } = candidate;
      return buildAnsweredBlocks({
        answerLabel,
        promptBlocks: [withoutActions],
        userId: card.userId,
      });
    });
    await channel.slack.request("chat.update", {
      blocks,
      channel: channel.state.channelId,
      text: `Answered: ${answerLabel}`,
      ts: card.messageTs,
    });
    const next = { ...cards };
    delete next[event.requestId];
    channel.state.pendingApprovalCards = next;
  },

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
    await channel.thread.startTyping(truncateTypingStatus(describeActionRequests(event.actions)));
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
      event.candidateId === undefined
        ? (slackUserIdFromAuthContext(ctx.session.auth.current) ??
          channel.state.triggeringUserId ??
          null)
        : (channel.state.pendingApprovalCandidateUsers?.[event.candidateId] ?? null);
    const challengeUrl = event.authorization?.url;

    // Post a public, link-free status so everyone in the thread can see
    // the session is blocked and later see it complete. The challenge
    // itself remains private.
    const pending = channel.state.pendingAuthMessageTs ?? {};
    if (event.candidateId === undefined && pending[event.name] === undefined) {
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
    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    if (event.outcome === "authorized" && event.candidateId === undefined) {
      await channel.thread.startTyping(`Connected to ${displayName}. Resuming...`);
    }

    const pending = channel.state.pendingAuthMessageTs ?? {};
    const ts = pending[event.name];
    if (ts === undefined) return;

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
