import { errorHintOf } from "#public/channels/reply.js";
import { displayTitle } from "#shared/display-name.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import { workingTaskNames } from "#channel/task-card.js";
import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, formatErrorHint } from "#internal/logging.js";
import {
  reviewingResults,
  waitingOnTasks,
  withMoreCalls,
} from "#public/channels/slack/action-status.js";
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
  /** The run's tool calls: the first call's label, or the model's narration, and how many. */
  calls: { readonly count: number; readonly label: string; readonly narrated: boolean } | null;
  /** The current reasoning block, and when a piece of it last showed. */
  reasoning: string;
  reasoningShownAtMs: number | null;
  replyChars: number;
  readonly runId: string;
  /** The kinds of the run's streaming parts: later deltas name only their part. */
  readonly partKinds: Map<string, string>;
}
const streamByState = new WeakMap<SlackChannelState, StepStream>();

function stepStream(state: SlackChannelState, runId: string): StepStream {
  const current = streamByState.get(state);
  if (current?.runId === runId) return current;
  const fresh: StepStream = {
    calls: null,
    partKinds: new Map(),
    reasoning: "",
    reasoningShownAtMs: null,
    replyChars: 0,
    runId,
  };
  streamByState.set(state, fresh);
  return fresh;
}

/** The stream a content delta belongs to, and the kind of its part. */
function deltaStream(
  state: SlackChannelState,
  event: { readonly partId: string; readonly kind?: string },
  runId: string | undefined,
): { readonly stream: StepStream; readonly kind: string } | undefined {
  if (runId !== undefined && event.kind !== undefined) {
    const stream = stepStream(state, runId);
    stream.partKinds.set(event.partId, event.kind);
    return { kind: event.kind, stream };
  }
  const current = streamByState.get(state);
  const kind = current?.partKinds.get(event.partId);
  return current === undefined || kind === undefined ? undefined : { kind, stream: current };
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
  async "turn.paused"(event, channel, _ctx) {
    if (event.awaiting.some((entry) => "interactionId" in entry)) {
      await hideStatus(channel);
      return;
    }
    const working = workingTaskNames(channel.state.taskCards?.[event.turnId]?.turn);
    if (working.length > 0) await showStatus(channel, waitingOnTasks(working));
  },

  // The turn's next model run reads the results, so `model.started` can say so.
  async "task.settled"(event, channel, _ctx) {
    if (event.cancel !== undefined) return;
    const pending = channel.state.pendingTaskResults;
    const names = pending?.turnId === event.turnId ? pending.names : [];
    const name = event.kind === "agent" && event.name !== undefined ? event.name : null;
    channel.state.pendingTaskResults = { names: [...names, name], turnId: event.turnId };
  },

  // A model run means nothing to someone reading the thread, so the status
  // keeps naming the work, such as the call that just finished, and is written
  // again so Slack doesn't time it out. Only task results the run is about to
  // read change it.
  async "model.started"(_event, channel, ctx) {
    const turnId = ctx.scope?.turnId;
    if (turnId === undefined) return;
    const pending = channel.state.pendingTaskResults;
    channel.state.pendingTaskResults = null;
    const status =
      pending?.turnId === turnId
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

  // Shows the newest heading or sentence of reasoning, each for at least a few seconds, so a
  // long reasoning block reads as progress instead of its opening words, and says a reply is on
  // its way once its text gets going.
  async "content.delta"(event, channel, ctx) {
    const found = deltaStream(channel.state, event, ctx.scope?.runId);
    if (found === undefined) return;
    const { kind, stream } = found;
    if (kind === "reasoning") {
      if (stream.reasoning === "") stream.reasoningShownAtMs = null;
      stream.reasoning += event.delta;
      await showReasoning(channel, stream);
      return;
    }
    if (kind !== "text") return;
    const before = stream.replyChars;
    stream.replyChars += event.delta.length;
    if (before < WRITING_REPLY_MIN_CHARS && stream.replyChars >= WRITING_REPLY_MIN_CHARS) {
      await showStatus(channel, "Writing a reply...");
    }
  },

  // Calls in one run stream in one at a time, so the run keeps its first
  // label, or the model's narration, and counts the rest. Calls a tool makes
  // on the model's behalf, such as a connection tool, belong to their parent.
  async "call.requested"(event, channel, _ctx) {
    const narration = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    const { capability, owner } = event;
    const counts = !("callId" in owner) && !isTaskControlTool(capability.name);
    if (!narration && !counts) return;
    if (!("runId" in owner)) return;
    const stream = stepStream(channel.state, owner.runId);
    const label = capability.title ?? displayTitle(capability.name);
    const calls =
      !narration && stream.calls
        ? { ...stream.calls, count: stream.calls.count + 1 }
        : { count: counts ? 1 : 0, label: narration ?? label, narrated: narration != null };
    stream.calls = calls;
    await showStatus(
      channel,
      calls.narrated ? calls.label : withMoreCalls(calls.label, calls.count),
    );
  },

  async "call.progress"(event, channel, _ctx) {
    const label = event.title;
    if (!label || heldWithin(channel.state.threadStatus?.atMs, Date.now())) return;
    await showStatus(channel, label);
  },

  async "call.settled"(event, channel, _ctx) {
    if (event.title) await showStatus(channel, event.title);
  },

  async "content.completed"(event, channel, ctx) {
    if (event.kind === "reasoning") {
      const stream = streamByState.get(channel.state);
      if (stream?.runId !== event.runId || typeof event.value !== "string") return;
      stream.reasoning = event.value;
      await showReasoning(channel, stream, { complete: true });
      stream.reasoning = "";
      return;
    }
    if (event.kind !== "text") return;
    const text = typeof event.value === "string" ? event.value : "";
    if (contentPhase(event.phase) === "narration") {
      channel.state.pendingToolCallMessage = text ? (firstNonEmptyLine(text) ?? null) : null;
      return;
    }
    channel.state.pendingToolCallMessage = null;
    if (!text) {
      await clearStatus(channel);
      return;
    }
    // Slack clears the status when the reply posts.
    channel.state.threadStatus = null;
    await deliverCompletedSlackReply(channel, text, { turnId: ctx.session.turn.id });
  },

  // A reply clears the status, but a turn ended by an `endsTurn` tool posts
  // none, and Slack would otherwise show the status until it times out.
  async "turn.settled"(event, channel, _ctx) {
    if (event.outcome !== "failed") {
      await clearStatus(channel);
      return;
    }
    const errorId = event.error?.id;
    const summary = formatErrorHint(errorHintOf(event.error));
    await channel.thread.post(
      [
        `I hit an error while handling your request${summary}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "session.ended"(event, channel, _ctx) {
    if (event.outcome !== "failed") return;
    const errorId = event.error?.id;
    const summary = formatErrorHint(errorHintOf(event.error));
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
