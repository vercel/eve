import type { SessionAuthContext } from "eve/context";
import type { Interaction } from "eve/events";
import {
  postedIn,
  signInChallengeText,
  type SignIn,
  type SignInSurface,
  renderTextInteraction,
  surfaceEvents,
} from "eve/internal/channels";
import type { RecallParticipant } from "./inbound.js";
import type {
  RecallChannelEvents,
  RecallContext,
  RecallEventContext,
  RecallInboundResult,
  RecallRespondInput,
} from "./recallChannel.js";
import type { RecallMeetingEvent } from "./inbound.js";

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

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
];
/** Words people wrap a choice in, such as "okay, let's go with option two, please". */
const FILLER_WORDS = new Set(
  "okay ok so um uh hey yes yeah yep sure please it that this the option number let's lets go with do pick choose i we and then".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/gu, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * The option a natural reply picks, such as "Okay eve, approve it" or "eve,
 * option one". Drops the bot's name, filler words, and number words, then
 * matches what's left exactly, so "neither, Thursday is bad" picks nothing.
 */
export function matchSpokenOption<T extends { readonly id: string; readonly label: string }>(
  text: string,
  botName: string,
  options: readonly T[],
): T | undefined {
  const name = words(botName);
  const optionWords = new Set(options.flatMap(({ id, label }) => [...words(id), ...words(label)]));
  const said = words(text);
  const rest: string[] = [];
  for (let i = 0; i < said.length; i++) {
    if (name.length > 0 && name.every((part, j) => said[i + j] === part)) {
      i += name.length - 1;
      continue;
    }
    const word = said[i]!;
    // "the second one": after an ordinal, "one" names the option, not a number.
    if (word === "one" && ORDINALS.includes(said[i - 1] ?? "")) continue;
    if (optionWords.has(word)) rest.push(word);
    else if (NUMBER_WORDS.includes(word)) rest.push(String(NUMBER_WORDS.indexOf(word) + 1));
    else if (ORDINALS.includes(word)) rest.push(String(ORDINALS.indexOf(word) + 1));
    else if (!FILLER_WORDS.has(word)) rest.push(word);
  }
  const phrase = rest.join(" ");
  if (!phrase) return undefined;
  const named = options.find(
    ({ id, label }) => words(id).join(" ") === phrase || words(label).join(" ") === phrase,
  );
  if (named !== undefined) return named;
  const index = Number(phrase);
  return Number.isInteger(index) && index >= 1 ? options[index - 1] : undefined;
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
  ...surfaceEvents<RecallEventContext>({
    post: (channel, text) => channel.recall.sendChatMessage(text),
    restart: "meeting",
    // Meeting chat has no buttons, so a reply can only answer the request it sees.
    requests: { showOne: showPrompt },
    signIns: recallSignIns,
  }),
  // Text before a tool call is the agent saying it's starting, which a
  // meeting wants to hear about while it waits.
  async "content.completed"({ data }, { channel }) {
    if (data.kind !== "text" || typeof data.value !== "string" || !data.value) return;
    await channel.recall.sendChatMessage(data.value);
  },
};

export function recallSignIns(channel: RecallEventContext): SignInSurface {
  const post = async (text: string) => {
    await channel.recall.sendChatMessage(text);
    return undefined;
  };
  return {
    private: false,
    postChallenge: (signIn) => post(signInChallengeText(signIn)),
    // A sign-in link or code is a credential, so it goes only to the person signing in.
    async deliverPrivately(signIn) {
      if (!hasCredential(signIn)) return false;
      const participantId = participantIdOf(signIn.principalId, channel.recall.botId);
      if (participantId === undefined || !channel.recall.supportsDirectMessages) return false;
      return channel.recall.sendChatMessage(signInChallengeText(signIn), { to: participantId });
    },
    postStatus(signIn, delivered) {
      // Instructions alone, such as "approve on your phone", are safe for everyone to see.
      if (!hasCredential(signIn)) return post(signInChallengeText(signIn));
      return post(
        delivered
          ? `${signIn.displayName} needs a sign-in. I sent the link privately.`
          : `${signIn.displayName} needs a sign-in, and this meeting's chat can't deliver a private link. Connect ${signIn.displayName} outside the meeting, then ask again.`,
      );
    },
    post,
    posted: postedIn(channel.state, "pendingSignIns"),
  };
}

function hasCredential(signIn: SignIn): boolean {
  return Boolean(signIn.url || signIn.userCode);
}

async function showPrompt(channel: RecallEventContext, interaction: Interaction): Promise<boolean> {
  const { request } = interaction;
  const body = renderTextInteraction(request);
  const instruction =
    (request.options ?? []).length === 0
      ? undefined
      : request.allowFreeform === true
        ? "Reply with a number, or with your own answer."
        : "Reply with a number to choose.";
  const shown = await channel.recall.sendChatMessage(
    instruction === undefined ? body : `${body}\n\n${instruction}`,
  );
  if (shown) {
    channel.state.shownOptions = {
      options: (request.options ?? []).map(({ id, label }) => ({ id, label })),
      requestId: interaction.interactionId,
    };
  }
  return shown;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
