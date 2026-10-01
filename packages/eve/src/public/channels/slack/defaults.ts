import { workingTaskNames } from "#channel/task-card.js";
import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import { describeActionRequests, waitingOnTasks } from "#public/channels/slack/action-status.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import { buildSlackAuthContext, slackUserIdForPrincipal } from "#public/channels/slack/auth.js";
import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthEphemeralText,
  buildAuthRequiredPublicText,
  formatConnectionDisplayName,
  type ConnectionAuthorizationOutcome,
} from "#public/channels/slack/connections.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import { approvalEvents } from "#public/channels/slack/approval-cards.js";
import { deliverCompletedSlackReply } from "#public/channels/slack/reply-delivery.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";
import type {
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackContext,
  SlackMentionResult,
} from "#public/channels/slack/slackChannel.js";

const log = createLogger("slack.defaults");
const REASONING_TYPING_REFRESH_INTERVAL_MS = 5_000;
const REASONING_TYPING_MIN_PROGRESS_CHARS = 4;
interface ReasoningAccumulator {
  readonly stepIndex: number;
  readonly text: string;
  readonly turnId: string;
}
const reasoningByState = new WeakMap<SlackChannelState, ReasoningAccumulator>();

interface SlackSemanticErrorSummary {
  readonly hint?: string;
  readonly message: string;
  readonly name: string;
}

function extractSemanticErrorSummary(event: {
  readonly details?: unknown;
  readonly message?: string;
}): SlackSemanticErrorSummary | null {
  if (typeof event.details !== "object" || event.details === null) return null;
  const details = event.details as {
    readonly hint?: unknown;
    readonly message?: unknown;
    readonly name?: unknown;
    readonly semanticErrorId?: unknown;
  };
  if (
    typeof details.semanticErrorId !== "string" ||
    details.semanticErrorId.length === 0 ||
    typeof details.name !== "string" ||
    details.name.length === 0
  ) {
    return null;
  }

  const message =
    typeof details.message === "string" && details.message.trim().length > 0
      ? details.message.trim()
      : event.message?.trim();
  if (!message) return null;

  const hint =
    typeof details.hint === "string" && details.hint.trim().length > 0
      ? details.hint.trim()
      : undefined;
  return hint === undefined
    ? { message, name: details.name }
    : { hint, message, name: details.name };
}

function formatSemanticErrorBlock(
  summary: SlackSemanticErrorSummary,
  errorId: string | undefined,
): string {
  const lines = [
    `### ${summary.name}`,
    "",
    summary.message,
    ...(summary.hint ? ["", "**How to fix**", summary.hint] : []),
    ...(errorId ? ["", "**Error id:**", `\`${errorId}\``] : []),
  ];
  return lines
    .flatMap((line) => line.split("\n"))
    .map((line) => (line.length > 0 ? `> ${line}` : "> "))
    .join("\n");
}

function formatSemanticErrorReply(input: {
  readonly errorId: string | undefined;
  readonly followUp?: string;
  readonly introduction: string;
  readonly nextStep: string;
  readonly summary: SlackSemanticErrorSummary;
}): string {
  return [
    `${input.introduction}.`,
    "",
    formatSemanticErrorBlock(input.summary, input.errorId),
    ...(!input.summary.hint ? ["", input.nextStep] : []),
    ...(input.summary.hint && input.followUp ? ["", input.followUp] : []),
  ].join("\n");
}

/**
 * Workspace-scoped projection of the Slack actor that produced
 * `message`, derived into a {@link SessionAuthContext}. Used by both
 * {@link defaultOnMessage} when
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
    installationTeamId: message.installationTeamId,
    isBot: author.isBot,
    teamId: message.teamId,
    threadTs: ctx.slack.threadTs,
    userId: author.userId,
    userName: author.userName,
  });
}

/**
 * Default `onAppMention` and `onDirectMessage`: dispatches with auth derived
 * from the Slack actor. Acknowledging the message is the renderer chain's
 * `received`, so replacing a message hook never drops it.
 */
export function defaultOnMessage(ctx: SlackContext, message: SlackMessage): SlackMentionResult {
  return { auth: defaultSlackAuth(message, ctx) };
}

/** eve's default `received`: the `Thinking...` status, set the moment a message arrives. */
export async function defaultReceived(_message: SlackMessage, ctx: SlackContext): Promise<void> {
  await ctx.thread.startTyping("Thinking...");
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
 * eve's default Slack event rendering: status lines, replies, errors, and the
 * connection-authorization flow. It is the innermost link of every channel's
 * renderer chain. Typed as the internal full-context map because the default
 * `authorization.required` handler owns the public link-free status, which
 * authored renderers cannot express.
 */
export const defaultEvents: SlackChannelInternalEvents = {
  ...approvalEvents,
  async "turn.waiting"(event, channel, _ctx) {
    const working = workingTaskNames(channel.state.taskCards?.[event.turnId]?.turn);
    if (working.length > 0) await channel.thread.startTyping(waitingOnTasks(working));
  },

  // The turn's next model step reads the results, so `step.started` can say so.
  async "task.settled"(event, channel, _ctx) {
    if (event.cancel === undefined) channel.state.pendingTaskResultsTurnId = event.turnId;
  },

  // Each later step replaces the status left by the previous one, such as a
  // finished tool's label or `Waiting on 3 tasks...`, which would otherwise
  // linger until the model streams something. `turn.started` covers step 0.
  async "step.started"(event, channel, _ctx) {
    if (event.stepIndex === 0) return;
    const reviewing = channel.state.pendingTaskResultsTurnId === event.turnId;
    channel.state.pendingTaskResultsTurnId = null;
    await channel.thread.startTyping(reviewing ? "Reviewing results..." : "Thinking...");
  },

  async "turn.started"(_event, channel, _ctx) {
    channel.state.pendingTaskResultsTurnId = null;
    channel.state.pendingToolCallMessage = null;
    channel.state.lastReasoningTypingAtMs = null;
    channel.state.lastReasoningTypingStatus = null;
    reasoningByState.delete(channel.state);
    await channel.thread.startTyping("Working...");
  },

  // A reply clears the status, but a turn ended by an `endsTurn` tool posts
  // none, and Slack would otherwise show the status until it times out.
  async "turn.completed"(_event, channel, _ctx) {
    await channel.thread.startTyping();
  },

  async "reasoning.appended"(event, channel, _ctx) {
    const current = reasoningByState.get(channel.state);
    const continuesCurrentBlock =
      current?.turnId === event.turnId && current.stepIndex === event.stepIndex;
    if (!continuesCurrentBlock) {
      channel.state.lastReasoningTypingAtMs = null;
      channel.state.lastReasoningTypingStatus = null;
    }
    const reasoning = (continuesCurrentBlock ? current.text : "") + event.reasoningDelta;
    reasoningByState.set(channel.state, {
      stepIndex: event.stepIndex,
      text: reasoning,
      turnId: event.turnId,
    });
    const line = firstNonEmptyLine(reasoning);
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

  async "reasoning.completed"(event, channel, _ctx) {
    const current = reasoningByState.get(channel.state);
    if (current?.turnId !== event.turnId || current.stepIndex !== event.stepIndex) return;
    reasoningByState.delete(channel.state);
    channel.state.lastReasoningTypingAtMs = null;
    channel.state.lastReasoningTypingStatus = null;
  },

  async "actions.requested"(event, channel, _ctx) {
    const buffered = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    if (buffered) {
      await channel.thread.startTyping(truncateTypingStatus(buffered));
      return;
    }
    const actions = event.actions.filter(
      (action) => action.kind !== "tool-call" || !isTaskControlTool(action.toolName),
    );
    if (actions.length === 0) return;
    await channel.thread.startTyping(
      truncateTypingStatus(describeActionRequests(actions, event.presentation)),
    );
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
    await deliverCompletedSlackReply(channel, event.message, { turnId: event.turnId });
  },

  async "turn.failed"(event, channel, _ctx) {
    const errorId = extractErrorId(event.details);
    const semanticSummary = extractSemanticErrorSummary(event);
    if (semanticSummary !== null) {
      await channel.thread.post(
        formatSemanticErrorReply({
          errorId,
          introduction: "I hit an error while handling your request",
          nextStep: "Please try again, rephrase, or reach out if it keeps failing.",
          summary: semanticSummary,
        }),
      );
      return;
    }

    const summary = formatErrorHint(event);
    await channel.thread.post(
      [
        `I hit an error while handling your request${summary}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "session.failed"(event, channel) {
    const errorId = extractErrorId(event.details);
    const semanticSummary = extractSemanticErrorSummary(event);
    if (semanticSummary !== null) {
      await channel.thread.post(
        formatSemanticErrorReply({
          errorId,
          followUp: "Start a new thread to continue — I can't pick this one back up.",
          introduction: "This session couldn't recover from an error",
          nextStep: "Resolve the issue, then start a new thread — I can't pick this one back up.",
          summary: semanticSummary,
        }),
      );
      return;
    }

    const summary = formatErrorHint(event);
    await channel.thread.post(
      [
        `This session couldn't recover from an error${summary}.`,
        "",
        "Start a new thread to continue — I can't pick this one back up.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "authorization.required"(event, channel, _ctx) {
    const displayName = event.authorization?.displayName ?? formatConnectionDisplayName(event.name);
    const recipientUserId = slackUserIdForPrincipal(channel.state, event.principalId) ?? null;
    const challengeUrl = event.authorization?.url;

    // Post a public, link-free status so everyone in the thread can see
    // the session is blocked and later see it complete. The challenge
    // itself remains private.
    const pending = channel.state.pendingAuthMessageTs ?? {};
    if (event.candidateId === undefined && pending[event.name] === undefined) {
      const publicText = buildAuthRequiredPublicText({ displayName, recipientUserId });
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
    // must only ever be visible to the person who started the sign-in, never posted into
    // the shared thread.
    if (recipientUserId && challengeUrl) {
      const { channelId, threadTs } = channel.state;
      // The turn's own sign-in holds it, so the prompt can cancel that turn.
      const cancel =
        event.candidateId === undefined && channelId && threadTs && event.turnId
          ? { channelId, threadTs, turnId: event.turnId }
          : undefined;
      const prompt = {
        cancel,
        displayName,
        url: challengeUrl,
        userCode: event.authorization?.userCode,
      };
      try {
        await channel.thread.postEphemeral(recipientUserId, {
          blocks: buildAuthEphemeralBlocks(prompt),
          text: buildAuthEphemeralText(prompt),
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
