import { promptQueueEvents } from "#channel/prompt-queue.js";
import { renderTextInputRequest } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import { extractErrorId, formatErrorHint } from "#internal/logging.js";
import type { ConnectionAuthorizationOutcome } from "#protocol/message.js";
import { displayProperName } from "#shared/display-name.js";
import type { InputRequest } from "#shared/input.js";
import type { RecallParticipant } from "#public/channels/recall/inbound.js";
import type {
  RecallChannelEvents,
  RecallContext,
  RecallEventContext,
  RecallInboundResult,
  RecallRespondInput,
} from "#public/channels/recall/recallChannel.js";
import type { RecallMeetingEvent } from "#public/channels/recall/inbound.js";

const RECALL_AUTHENTICATOR = "recall-webhook";

/**
 * One principal per meeting participant, `recall:<botId>:<participantId>`.
 * Participant ids are scoped to one bot, so the principal never carries over
 * to another meeting. The name and email come from the meeting platform and
 * prove nothing.
 */
export function recallParticipantAuth(event: {
  readonly botId: string;
  readonly participant: RecallParticipant;
}): SessionAuthContext {
  const { participant } = event;
  const attributes: Record<string, string> = {
    botId: event.botId,
    isHost: String(participant.isHost),
    name: participant.name,
    participantId: participant.id,
  };
  if (participant.platform !== undefined) attributes.platform = participant.platform;
  return {
    attributes,
    authenticator: RECALL_AUTHENTICATOR,
    issuer: "recall",
    principalId: recallParticipantPrincipalId(event.botId, participant.id),
    principalType: "user",
  };
}

/**
 * One service principal for the whole meeting, `recall:<botId>`. Everyone in
 * the meeting acts as it, which lets the `queue` turn policy batch a burst of
 * utterances from different speakers into one turn.
 */
export function recallMeetingAuth(event: { readonly botId: string }): SessionAuthContext {
  return {
    attributes: { botId: event.botId },
    authenticator: RECALL_AUTHENTICATOR,
    issuer: "recall",
    principalId: `recall:${event.botId}`,
    principalType: "service",
  };
}

export function recallParticipantPrincipalId(botId: string, participantId: string): string {
  return `recall:${botId}:${participantId}`;
}

/** The participant id in a principal {@link recallParticipantAuth} made for `botId`, if it is one. */
export function participantIdOf(
  principalId: string | undefined,
  botId: string,
): string | undefined {
  const prefix = `recall:${botId}:`;
  return principalId?.startsWith(prefix) ? principalId.slice(prefix.length) : undefined;
}

/**
 * Whether an utterance names the bot as a word, such as "eve, open a ticket"
 * or "thanks eve". Transcription drops case and punctuation, so this matches
 * loosely.
 */
export function isAddressedTo(text: string, botName: string): boolean {
  const name = botName.trim().toLowerCase();
  if (!name) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, "iu").test(
    text.toLowerCase(),
  );
}

/** Default inbound hook: speech, chat, joins, and leaves, each as its participant. */
export function defaultOnMeetingEvent(
  _ctx: RecallContext,
  event: RecallMeetingEvent,
): RecallInboundResult {
  return event.type === "status" ? null : { auth: recallParticipantAuth(event) };
}

/** Default respond check: every chat message, and speech that names the bot. */
export function defaultShouldRespond(input: RecallRespondInput): boolean {
  const { event } = input;
  if (event.type === "chat") return true;
  return event.type === "speech" && isAddressedTo(event.text, input.botName);
}

/** Built-in Recall event handlers: chat replies, typed prompts, private sign-ins, and errors. */
export const defaultEvents: RecallChannelEvents = {
  async "message.completed"(event, channel) {
    // Text before a tool call is the agent saying it's starting, which a
    // meeting wants to hear about while it waits.
    if (!event.message) return;
    const { replyTo } = channel.state;
    if (replyTo === undefined) {
      await channel.recall.sendChatMessage(event.message);
    } else if (channel.recall.supportsDirectMessages) {
      await channel.recall.sendChatMessage(event.message, { to: replyTo });
    } else {
      await channel.recall.sendChatMessage(
        "I got a private message, but this meeting's chat can't reply privately.",
      );
    }
  },

  // Meeting chat has no buttons, so a reply can only answer the request it sees.
  ...promptQueueEvents(showPrompt),

  async "authorization.required"(event, channel) {
    if (event.candidateId !== undefined) return;
    const displayName = event.authorization?.displayName ?? displayProperName(event.name);
    const challenge = event.authorization;
    const prompt = [
      `Sign in to ${displayName} to continue.`,
      challenge?.instructions,
      challenge?.userCode ? `Code: ${challenge.userCode}` : undefined,
      challenge?.url,
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n");
    // Instructions alone, such as "approve on your phone", are safe for everyone to see.
    if (!challenge?.url && !challenge?.userCode) {
      await channel.recall.sendChatMessage(prompt);
      return;
    }
    const participantId = participantIdOf(event.principalId, channel.recall.botId);
    // A sign-in link or code is a credential, so it goes only to the person signing in.
    if (
      participantId !== undefined &&
      channel.recall.supportsDirectMessages &&
      (await channel.recall.sendChatMessage(prompt, { to: participantId }))
    ) {
      await channel.recall.sendChatMessage(
        `${displayName} needs a sign-in. I sent the link privately.`,
      );
      return;
    }
    await channel.recall.sendChatMessage(
      `${displayName} needs a sign-in, and this meeting's chat can't deliver a private link. Connect ${displayName} outside the meeting, then ask again.`,
    );
  },

  async "authorization.completed"(event, channel) {
    if (event.candidateId !== undefined) return;
    await channel.recall.sendChatMessage(
      renderAuthorizationOutcome({
        displayName: event.authorization?.displayName ?? displayProperName(event.name),
        outcome: event.outcome,
        reason: event.reason,
      }),
    );
  },

  async "turn.failed"(event, channel) {
    if (event.terminal) return;
    const errorId = extractErrorId(event.details);
    await channel.recall.sendChatMessage(
      `I hit an error${formatErrorHint(event)}. Please ask again.${errorId ? ` (Error id: ${errorId})` : ""}`,
    );
  },

  async "session.failed"(event, channel) {
    const errorId = extractErrorId(event.details);
    await channel.recall.sendChatMessage(
      `I can't continue in this meeting after an error${formatErrorHint(event)}.${errorId ? ` (Error id: ${errorId})` : ""}`,
    );
  },
};

async function showPrompt(channel: RecallEventContext, request: InputRequest): Promise<boolean> {
  const body = renderTextInputRequest(request);
  const instruction =
    (request.options ?? []).length === 0
      ? undefined
      : request.allowFreeform === true
        ? "Reply with a number, or with your own answer."
        : "Reply with a number to choose.";
  return await channel.recall.sendChatMessage(
    instruction === undefined ? body : `${body}\n\n${instruction}`,
  );
}

function renderAuthorizationOutcome(input: {
  readonly displayName: string;
  readonly outcome: ConnectionAuthorizationOutcome;
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") return `${input.displayName} connected.`;
  if (input.outcome === "declined") return `${input.displayName} sign-in cancelled.`;
  const outcome = input.outcome === "timed-out" ? "timed out" : input.outcome;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return `${input.displayName} sign-in ${outcome}${reason}.`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
