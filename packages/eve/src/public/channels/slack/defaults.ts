import { workingTaskNames } from "#channel/task-card.js";
import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, extractErrorId, formatErrorHint } from "#internal/logging.js";
import {
  actionLabel,
  reviewingResults,
  waitingOnTasks,
  withMoreCalls,
} from "#public/channels/slack/action-status.js";
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
  SlackEventContext,
  SlackMentionResult,
} from "#public/channels/slack/slackChannel.js";
import {
  clearStatus,
  hideStatus,
  reasoningStatus,
  showStatus,
} from "#public/channels/slack/thread-status.js";

const log = createLogger("slack.defaults");
/** Each piece of reasoning, or a tool's progress, stays up at least this long so it can be read. */
const STATUS_HOLD_MS = 3_000;
/** Narration before tool calls rarely runs this long, so longer text is the reply being written. */
const WRITING_REPLY_MIN_CHARS = 280;

/**
 * What the current model step has streamed so far. One workflow step runs a
 * model call and delivers its events to the same state object, so this never
 * needs to survive serialization, and a new step starts empty.
 */
interface StepStream {
  /** The step's tool calls: the first call's label, or the model's narration, and how many. */
  calls: { readonly count: number; readonly label: string; readonly narrated: boolean } | null;
  /** The current reasoning block, and when a piece of it last showed. */
  reasoning: string;
  reasoningShownAtMs: number | null;
  replyChars: number;
  readonly stepIndex: number;
  readonly turnId: string;
}
const streamByState = new WeakMap<SlackChannelState, StepStream>();

function stepStream(state: SlackChannelState, turnId: string, stepIndex: number): StepStream {
  const current = streamByState.get(state);
  if (current?.turnId === turnId && current.stepIndex === stepIndex) return current;
  const fresh: StepStream = {
    calls: null,
    reasoning: "",
    reasoningShownAtMs: null,
    replyChars: 0,
    stepIndex,
    turnId,
  };
  streamByState.set(state, fresh);
  return fresh;
}

function heldWithin(atMs: number | null | undefined, now: number): boolean {
  return atMs != null && now - atMs >= 0 && now - atMs < STATUS_HOLD_MS;
}

async function showReasoning(
  channel: SlackEventContext,
  stream: StepStream,
  options?: { readonly complete?: boolean },
): Promise<void> {
  const piece = reasoningStatus(stream.reasoning, options);
  if (piece === undefined) return;
  if (truncateTypingStatus(piece) === channel.state.threadStatus?.text) return;
  const now = Date.now();
  if (heldWithin(stream.reasoningShownAtMs, now)) return;
  await showStatus(channel, piece);
  stream.reasoningShownAtMs = now;
}

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
  // A turn held on a person's approval, answer, or sign-in isn't working, and
  // the prompt asking them says so. Its status comes back when it resumes.
  async "turn.waiting"(event, channel, _ctx) {
    if (event.on === "input") {
      await hideStatus(channel);
      return;
    }
    const working = workingTaskNames(channel.state.taskCards?.[event.turnId]?.turn);
    if (working.length > 0) await showStatus(channel, waitingOnTasks(working));
  },

  // The turn's next model step reads the results, so `step.started` can say so.
  async "task.settled"(event, channel, _ctx) {
    if (event.cancel !== undefined) return;
    const pending = channel.state.pendingTaskResults;
    const names = pending?.turnId === event.turnId ? pending.names : [];
    const name = event.kind === "agent" && event.name !== undefined ? event.name : null;
    channel.state.pendingTaskResults = { names: [...names, name], turnId: event.turnId };
  },

  // A model step means nothing to someone reading the thread, so the status
  // keeps naming the work, such as the call that just finished, and is written
  // again so Slack doesn't time it out. Only task results the step is about to
  // read change it. `turn.started` covers step 0.
  async "step.started"(event, channel, _ctx) {
    if (event.stepIndex === 0) return;
    const pending = channel.state.pendingTaskResults;
    channel.state.pendingTaskResults = null;
    const status =
      pending?.turnId === event.turnId
        ? reviewingResults(pending.names)
        : (channel.state.threadStatus?.text ?? "Thinking...");
    await showStatus(channel, status, { force: true });
  },

  async "turn.started"(_event, channel, _ctx) {
    channel.state.pendingTaskResults = null;
    channel.state.pendingToolCallMessage = null;
    streamByState.delete(channel.state);
    await showStatus(channel, "Thinking...", { force: true });
  },

  // A reply clears the status, but a turn ended by an `endsTurn` tool posts
  // none, and Slack would otherwise show the status until it times out.
  async "turn.completed"(_event, channel, _ctx) {
    await clearStatus(channel);
  },

  // Shows the newest heading or sentence, each for at least a few seconds, so
  // a long reasoning block reads as progress instead of its opening words.
  async "reasoning.appended"(event, channel, _ctx) {
    const stream = stepStream(channel.state, event.turnId, event.stepIndex);
    if (stream.reasoning === "") stream.reasoningShownAtMs = null;
    stream.reasoning += event.reasoningDelta;
    await showReasoning(channel, stream);
  },

  // The block's last sentence never shows while it streams unless it fills
  // the status, so a short one only shows once the block ends.
  async "reasoning.completed"(event, channel, _ctx) {
    const stream = stepStream(channel.state, event.turnId, event.stepIndex);
    stream.reasoning = event.reasoning;
    await showReasoning(channel, stream, { complete: true });
    stream.reasoning = "";
  },

  async "message.appended"(event, channel, _ctx) {
    const stream = stepStream(channel.state, event.turnId, event.stepIndex);
    const before = stream.replyChars;
    stream.replyChars += event.messageDelta.length;
    if (before < WRITING_REPLY_MIN_CHARS && stream.replyChars >= WRITING_REPLY_MIN_CHARS) {
      await showStatus(channel, "Writing a reply...");
    }
  },

  // Calls in one step stream in one at a time, so the step keeps its first
  // label, or the model's narration, and counts the rest.
  async "actions.requested"(event, channel, _ctx) {
    const narration = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    const actions = event.actions.filter(
      (action) => action.kind !== "tool-call" || !isTaskControlTool(action.toolName),
    );
    if (!narration && actions.length === 0) return;
    const stream = stepStream(channel.state, event.turnId, event.stepIndex);
    const calls =
      !narration && stream.calls
        ? { ...stream.calls, count: stream.calls.count + actions.length }
        : {
            count: actions.length,
            label: narration ?? actionLabel(actions[0]!, event.presentation),
            narrated: narration != null,
          };
    stream.calls = calls;
    await showStatus(
      channel,
      calls.narrated ? calls.label : withMoreCalls(calls.label, calls.count),
    );
  },

  async "action.partial"(event, channel, _ctx) {
    const label = event.presentation?.[event.result.callId]?.label;
    if (!label || heldWithin(channel.state.threadStatus?.atMs, Date.now())) return;
    await showStatus(channel, label);
  },

  async "action.result"(event, channel, _ctx) {
    const label = event.presentation?.[event.result.callId]?.label;
    if (label) await showStatus(channel, label);
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
      await clearStatus(channel);
      return;
    }
    // Slack clears the status when the reply posts.
    channel.state.threadStatus = null;
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
    const instructions = event.authorization?.instructions;
    if (recipientUserId && (challengeUrl || instructions)) {
      const { channelId, threadTs } = channel.state;
      // The turn's own sign-in holds it, so the prompt can cancel that turn.
      const cancel =
        event.candidateId === undefined && channelId && threadTs && event.turnId
          ? { channelId, threadTs, turnId: event.turnId }
          : undefined;
      const prompt = {
        cancel,
        displayName,
        instructions,
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
      await showStatus(channel, `Connected to ${displayName}. Resuming...`, { force: true });
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
