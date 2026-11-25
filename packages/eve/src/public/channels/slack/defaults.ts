import { sessionTables, type SessionView } from "#protocol/session-projection/session-view.js";
import { errorHintOf } from "#public/channels/reply.js";
import { callLabel, showsActivity } from "#protocol/session-projection/selectors.js";
import type { ErrorInfo } from "#protocol/session-events/envelope.js";
import { contentPhase } from "#protocol/session-events/catalog.js";
import { waiting } from "#protocol/session-projection/selectors.js";
import { workingTaskNames } from "#channel/task-card.js";
import type { SessionAuthContext } from "#channel/types.js";

import { createLogger, formatErrorHint, logError } from "#internal/logging.js";
import {
  reviewingResults,
  waitingOnTasks,
  withMoreCalls,
} from "#public/channels/slack/action-status.js";
import { slackSessionTargetOf, type SlackApiResponse } from "#public/channels/slack/api.js";
import { buildSlackAuthContext, slackUserIdForPrincipal } from "#public/channels/slack/auth.js";
import {
  buildAuthCompletedText,
  buildAuthEphemeralBlocks,
  buildAuthEphemeralText,
  buildAuthRequiredPublicText,
} from "#public/channels/slack/connections.js";
import type { SlackMessage } from "#public/channels/slack/inbound.js";
import {
  notifyRefusedResponder,
  postRequestCards,
  settleRequestCard,
  showAnswerChange,
} from "#public/channels/slack/request-cards.js";
import type { SlackInteractionCardChain } from "#public/channels/slack/renderers.js";
import { refusedAnswerOf, requestBatchOf } from "#channel/interaction-prompts.js";
import { signInOf, type SignIn } from "#channel/sign-in.js";
import type { InteractionSettledData } from "#protocol/session-events/families/interaction.js";
import {
  checkThreadRootGone,
  deliverCompletedSlackReply,
} from "#public/channels/slack/reply-delivery.js";
import {
  SLACK_TYPING_STATUS_MAX_LENGTH,
  truncateTypingStatus,
} from "#public/channels/slack/limits.js";
import type {
  SlackApprovalChannelResolver,
  SlackChannelConfig,
  SlackChannelInternalEvents,
  SlackChannelState,
  SlackContext,
  SlackEventContext,
  SlackInboundMessageContext,
  SlackMentionResult,
} from "#public/channels/slack/slackChannel.js";
import {
  clearStatus,
  hideStatus,
  showStatus,
  showStatusBehindTurn,
  statusWritesSettled,
} from "#public/channels/slack/thread-status.js";
import { reasoningStatus } from "#channel/reasoning-status.js";

const log = createLogger("slack.defaults");
const STATUS_HOLD_MS = 3_000;
const WRITING_REPLY_MIN_CHARS = 280;

interface StepStream {
  calls: { readonly count: number; readonly label: string; readonly narrated: boolean } | null;
  reasoning: string;
  reasoningShownAtMs: number | null;
  replyChars: number;
  rootGone?: Promise<boolean>;
  readonly runId: string;
  readonly partKinds: Map<string, string>;
}
const streamByState = new WeakMap<SlackChannelState, StepStream>();
const turnsJustStarted = new WeakSet<SlackChannelState>();

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

function madeInsideCall(view: SessionView, callId: string): boolean {
  const owner = sessionTables(view).calls[callId]?.owner;
  return owner !== undefined && "callId" in owner;
}

async function showReasoning(
  channel: SlackEventContext,
  stream: StepStream,
  options?: { readonly complete?: boolean },
): Promise<void> {
  const piece = reasoningStatus(stream.reasoning, {
    complete: options?.complete,
    maxLength: SLACK_TYPING_STATUS_MAX_LENGTH,
  });
  if (piece === undefined) return;
  if (truncateTypingStatus(piece) === channel.state.threadStatus?.text) return;
  const now = Date.now();
  if (heldWithin(stream.reasoningShownAtMs, now)) return;
  await showStatus(channel, piece);
  stream.reasoningShownAtMs = now;
}

function formatFixableErrorReply(
  introduction: string,
  error: ErrorInfo,
  hint: string,
  options?: { readonly followUp?: string },
): string {
  const quoted = [
    error.message,
    "",
    "**How to fix**",
    hint,
    ...(error.id === undefined ? [] : ["", "**Error id:**", `\`${error.id}\``]),
  ]
    .flatMap((line) => line.split("\n"))
    .map((line) => (line.length > 0 ? `> ${line}` : "> "))
    .join("\n");
  return [
    `${introduction}.`,
    "",
    quoted,
    ...(options?.followUp === undefined ? [] : ["", options.followUp]),
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
    actionToken: message.actionToken,
    channelId: ctx.slack.channelId,
    email: author.email,
    fullName: author.fullName,
    installationTeamId: message.installationTeamId,
    isBot: author.isBot,
    teamId: message.teamId,
    threadTs: ctx.slack.threadTs,
    userId: author.userId,
    userName: author.userName,
  });
}

export function defaultOnMessage(ctx: SlackContext, message: SlackMessage): SlackMentionResult {
  return { auth: defaultSlackAuth(message, ctx) };
}

type SlackMessageHook = NonNullable<SlackChannelConfig["onMessage"]>;

export function defaultOnMessageEdited(
  hooks: Pick<SlackChannelConfig, "onAppMention" | "onDirectMessage" | "onMessage">,
): NonNullable<SlackChannelConfig["onMessageEdited"]> {
  return (ctx, edit) => {
    const hook = editedMessageHook(hooks, ctx, edit.message);
    return hook === undefined ? null : hook(ctx, edit.message);
  };
}

function editedMessageHook(
  hooks: Pick<SlackChannelConfig, "onAppMention" | "onDirectMessage" | "onMessage">,
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
): SlackMessageHook | undefined {
  if (message.raw.channel_type === "im") {
    return hooks.onDirectMessage ?? hooks.onMessage ?? defaultOnMessage;
  }
  if (ctx.isBotMentioned()) return hooks.onAppMention ?? hooks.onMessage ?? defaultOnMessage;
  if (ctx.slack.codeChannel) return hooks.onMessage ?? hooks.onAppMention ?? defaultOnMessage;
  return hooks.onMessage;
}

export async function defaultReceived(_message: SlackMessage, ctx: SlackContext): Promise<void> {
  await ctx.thread.startTyping("Thinking...");
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export async function showSlackSignIn(event: SignIn, channel: SlackEventContext): Promise<void> {
  const { displayName } = event;
  const recipientUserId = slackUserIdForPrincipal(channel.state, event.principalId) ?? null;
  const challengeUrl = event.url;

  if (
    recipientUserId &&
    (challengeUrl || event.instructions) &&
    !channel.slack.codeChannel &&
    channel.slack.threadTs === "" &&
    (await showSlackSignInDirectMessage(event, recipientUserId, channel))
  ) {
    return;
  }

  const pending = channel.state.pendingAuthMessageTs ?? {};
  if (event.responseId === undefined && pending[event.name] === undefined) {
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

  const { instructions } = event;
  if (recipientUserId && (challengeUrl || instructions)) {
    const target = slackSessionTargetOf(channel.slack);
    const cancel =
      event.responseId === undefined &&
      target.channelId &&
      (target.codeChannel || target.threadTs) &&
      event.turnId
        ? { ...target, turnId: event.turnId }
        : undefined;
    const prompt = {
      cancel,
      displayName,
      instructions,
      url: challengeUrl,
      userCode: event.userCode,
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
}

async function showSlackSignInDirectMessage(
  event: SignIn,
  recipientUserId: string,
  channel: SlackEventContext,
): Promise<boolean> {
  const pending = channel.state.pendingAuthDirectMessages ?? {};
  if (pending[event.interactionId] !== undefined) return true;
  const { channelId } = channel.slack;
  const prompt = {
    displayName: event.displayName,
    instructions: event.instructions,
    requestedInChannelId: channelId && !isSlackDirectMessageId(channelId) ? channelId : undefined,
    url: event.url,
    userCode: event.userCode,
  };
  let response: SlackApiResponse;
  try {
    response = await channel.slack.request("chat.postMessage", {
      blocks: buildAuthEphemeralBlocks(prompt),
      channel: recipientUserId,
      text: buildAuthEphemeralText(prompt),
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (error) {
    log.warn("Slack auth direct message delivery failed", { name: event.name, error });
    return false;
  }
  if (response.ok !== true) {
    log.warn("Slack auth direct message delivery failed", {
      name: event.name,
      error: response.error ?? "unknown_error",
    });
    return false;
  }
  const { channel: dmChannelId, ts } = response;
  if (typeof dmChannelId !== "string" || !dmChannelId || typeof ts !== "string" || !ts) {
    log.warn("Slack auth direct message has no channel or ts to edit", { name: event.name });
    return true;
  }
  channel.state.pendingAuthDirectMessages = {
    ...pending,
    [event.interactionId]: { channelId: dmChannelId, ts },
  };
  return true;
}

function isSlackDirectMessageId(channelId: string): boolean {
  return channelId.startsWith("D");
}

async function settleSlackSignInDirectMessage(
  event: SignIn,
  message: { readonly channelId: string; readonly ts: string },
  text: string,
  channel: SlackEventContext,
): Promise<void> {
  const target = { channel: message.channelId, ts: message.ts };
  try {
    const updated = await channel.slack.request("chat.update", {
      ...target,
      blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      text,
    });
    if (updated.ok === true) return;
    log.warn("Slack auth direct message edit failed", {
      name: event.name,
      error: updated.error ?? "unknown_error",
    });
  } catch (error) {
    log.warn("Slack auth direct message edit failed", { name: event.name, error });
  }
  try {
    const deleted = await channel.slack.request("chat.delete", target);
    if (deleted.ok !== true) {
      log.warn("Slack auth direct message delete failed", {
        name: event.name,
        error: deleted.error ?? "unknown_error",
      });
    }
  } catch (error) {
    log.warn("Slack auth direct message delete failed", { name: event.name, error });
  }
}

export async function settleSlackSignIn(
  event: SignIn,
  settled: InteractionSettledData,
  channel: SlackEventContext,
): Promise<void> {
  const { displayName } = event;
  if (settled.outcome === "accepted" && event.responseId === undefined) {
    await showStatus(channel, `Connected to ${displayName}. Resuming...`, { force: true });
  }

  const text = buildAuthCompletedText({
    displayName,
    outcome: settled.outcome,
    reason: settled.reason,
  });

  const directMessages = channel.state.pendingAuthDirectMessages ?? {};
  const directMessage = directMessages[event.interactionId];
  if (directMessage !== undefined) {
    await settleSlackSignInDirectMessage(event, directMessage, text, channel);
    const next = { ...directMessages };
    delete next[event.interactionId];
    channel.state.pendingAuthDirectMessages = next;
  }

  const pending = channel.state.pendingAuthMessageTs ?? {};
  const ts = pending[event.name];
  if (ts === undefined) return;

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
}

export function defaultInteractionEvents(
  approvalChannel: SlackApprovalChannelResolver | undefined,
  interactionCard: SlackInteractionCardChain,
): Pick<
  SlackChannelInternalEvents,
  "interaction.opened" | "interaction.settled" | "response.admitted" | "response.settled"
> {
  return {
    async "interaction.opened"({ data }, ctx) {
      const view = sessionTables(ctx.view);
      const batch = requestBatchOf(view, data);
      if (batch !== undefined) {
        await postRequestCards(batch, ctx, interactionCard, approvalChannel);
        return;
      }
      const signIn = signInOf(view, data.interactionId);
      if (signIn !== undefined && signIn.waitsOn === undefined)
        await showSlackSignIn(signIn, ctx.channel);
    },

    async "response.admitted"({ data }, ctx) {
      const response = sessionTables(ctx.view).responses[data.responseId];
      if (response !== undefined) {
        await showAnswerChange(response.interactionId, ctx, interactionCard);
      }
    },

    async "response.settled"({ data }, ctx) {
      const view = sessionTables(ctx.view);
      const response = view.responses[data.responseId];
      if (response !== undefined) {
        await showAnswerChange(response.interactionId, ctx, interactionCard);
      }
      const refused = refusedAnswerOf(view, data);
      if (refused === undefined) return;
      try {
        await notifyRefusedResponder(refused, ctx.channel);
      } catch (error) {
        logError(log, "failed to tell a refused responder why", error, {
          interactionId: refused.interactionId,
        });
      }
    },

    async "interaction.settled"({ data }, ctx) {
      const signIn = signInOf(sessionTables(ctx.view), data.interactionId);
      if (signIn !== undefined) {
        if (signIn.waitsOn === undefined) await settleSlackSignIn(signIn, data, ctx.channel);
        return;
      }
      await settleRequestCard(data.interactionId, ctx, interactionCard);
    },
  };
}

export const defaultEvents: SlackChannelInternalEvents = {
  async "turn.paused"(_event, { channel }) {
    await hideStatus(channel);
  },

  async "model.settled"(event, ctx) {
    const turnId = event.scope?.turnId;
    if (turnId === undefined || waiting(sessionTables(ctx.view), turnId)?.on !== "work") return;
    const working = workingTaskNames(sessionTables(ctx.view), turnId);
    if (working.length > 0) await showStatus(ctx.channel, waitingOnTasks(working));
  },

  "model.started"(event, ctx) {
    const { channel } = ctx;
    const turnId = event.scope?.turnId;
    if (turnId === undefined) return;
    const firstRun = turnsJustStarted.delete(channel.state);
    const pending = channel.state.pendingTaskResults;
    channel.state.pendingTaskResults = null;
    const results = pending?.turnId === turnId ? reviewingResults(pending.names) : undefined;
    showStatusBehindTurn(ctx, () => {
      const text = results ?? channel.state.threadStatus?.text ?? "Thinking...";
      return { text, force: !firstRun || text !== "Thinking..." };
    });
  },

  "turn.started"(_event, ctx) {
    const { channel } = ctx;
    channel.state.pendingTaskResults = null;
    channel.state.pendingToolCallMessage = null;
    streamByState.delete(channel.state);
    turnsJustStarted.add(channel.state);
    showStatusBehindTurn(ctx, () => ({ text: "Thinking...", force: true }));
  },

  async "content.delta"(event, ctx) {
    const { data } = event;
    const { channel } = ctx;
    const found = deltaStream(channel.state, data, event.scope?.runId);
    if (found === undefined) return;
    const { kind, stream } = found;
    if (kind === "reasoning") {
      if (stream.reasoning === "") stream.reasoningShownAtMs = null;
      stream.reasoning += data.delta;
      await showReasoning(channel, stream);
      return;
    }
    if (kind !== "text") return;
    const before = stream.replyChars;
    stream.replyChars += data.delta.length;
    if (before === 0 && stream.replyChars > 0 && stream.rootGone === undefined) {
      stream.rootGone = checkThreadRootGone(channel);
    }
    if (before < WRITING_REPLY_MIN_CHARS && stream.replyChars >= WRITING_REPLY_MIN_CHARS) {
      await showStatus(channel, "Writing a reply...");
    }
  },

  async "call.requested"({ data }, { channel }) {
    const { capability, owner } = data;
    if ("callId" in owner) return;
    const narration = channel.state.pendingToolCallMessage;
    channel.state.pendingToolCallMessage = null;
    const counts = showsActivity(capability);
    if (!narration && !counts) return;
    if ("turnId" in owner) {
      await showStatus(channel, narration ?? callLabel(data));
      return;
    }
    if (!("runId" in owner)) return;
    const stream = stepStream(channel.state, owner.runId);
    const label = callLabel(data);
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

  async "call.progress"({ data }, ctx) {
    const { channel } = ctx;
    const label = data.label;
    if (!label || madeInsideCall(ctx.view, data.callId)) return;
    if (heldWithin(channel.state.threadStatus?.atMs, Date.now())) return;
    await showStatus(channel, label);
  },

  async "call.settled"(event, ctx) {
    const { data } = event;
    const { channel } = ctx;
    const { taskId, turnId } = event.scope ?? {};
    if (taskId !== undefined && turnId !== undefined && data.outcome !== "interrupted") {
      const task = sessionTables(ctx.view).tasks[taskId];
      const pending = channel.state.pendingTaskResults;
      const names = pending?.turnId === turnId ? pending.names : [];
      const name = task?.kind === "agent" ? task.name : null;
      channel.state.pendingTaskResults = { names: [...names, name], turnId };
    }
    if (data.label && !madeInsideCall(ctx.view, data.callId)) {
      await showStatus(channel, data.label);
    }
  },

  async "content.completed"({ data }, ctx) {
    const { channel } = ctx;
    if (data.kind === "reasoning") {
      const stream = streamByState.get(channel.state);
      if (stream === undefined || stream.runId !== data.runId || typeof data.value !== "string")
        return;
      stream.reasoning = data.value;
      await showReasoning(channel, stream, { complete: true });
      stream.reasoning = "";
      return;
    }
    if (data.kind !== "text") return;
    const text = typeof data.value === "string" ? data.value : "";
    if (contentPhase(data.phase) === "narration") {
      channel.state.pendingToolCallMessage = text ? (firstNonEmptyLine(text) ?? null) : null;
      return;
    }
    channel.state.pendingToolCallMessage = null;
    if (!text) {
      await clearStatus(channel);
      return;
    }
    const stream = streamByState.get(channel.state);
    const prefetched =
      stream !== undefined && stream.runId === data.runId ? stream.rootGone : undefined;
    if (prefetched !== undefined && stream !== undefined) stream.rootGone = undefined;
    const rootGone = prefetched ?? checkThreadRootGone(channel);
    await statusWritesSettled(channel);
    channel.state.threadStatus = null;
    await deliverCompletedSlackReply(channel, text, { rootGone, turnId: ctx.session.turn.id });
  },

  async "turn.settled"({ data }, { channel }) {
    await statusWritesSettled(channel);
    if (data.outcome !== "failed") {
      await clearStatus(channel);
      return;
    }
    if (channel.state.codeChannel === true) await clearStatus(channel);
    const hint = data.error?.hint;
    if (data.error !== undefined && hint !== undefined) {
      await channel.thread.post(
        formatFixableErrorReply("I hit an error while handling your request", data.error, hint),
      );
      return;
    }
    const errorId = data.error?.id;
    const summary = formatErrorHint(errorHintOf(data.error));
    await channel.thread.post(
      [
        `I hit an error while handling your request${summary}.`,
        "",
        "Please try again, rephrase, or reach out if it keeps failing.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },

  async "session.ended"({ data }, { channel }) {
    if (data.outcome !== "failed") return;
    const hint = data.error?.hint;
    if (data.error !== undefined && hint !== undefined) {
      await channel.thread.post(
        formatFixableErrorReply("This session couldn't recover from an error", data.error, hint, {
          followUp: "Start a new thread to continue — I can't pick this one back up.",
        }),
      );
      return;
    }
    const errorId = data.error?.id;
    const summary = formatErrorHint(errorHintOf(data.error));
    await channel.thread.post(
      [
        `This session couldn't recover from an error${summary}.`,
        "",
        "Start a new thread to continue — I can't pick this one back up.",
        ...(errorId ? ["", `_Error id: \`${errorId}\`_`] : []),
      ].join("\n"),
    );
  },
};
