/**
 * Slack emoji reactions: the standard fallback set, the tools' input schemas,
 * message targeting, and add/remove calls that treat Slack's idempotent
 * errors as outcomes.
 */
import { z } from "zod";

type SlackReactionCall = (input: {
  readonly channel: string;
  readonly name: string;
  readonly timestamp: string;
}) => Promise<{ readonly ok?: boolean; readonly error?: string }>;

/** The Slack Web API calls reactions need. */
export interface SlackReactionClient {
  readonly reactions: { readonly add: SlackReactionCall; readonly remove: SlackReactionCall };
}

/** A custom emoji found for a reaction's `query`. */
export interface EmojiMatch {
  readonly name: string;
}

/** Finds up to `limit` custom workspace emoji for a vibe; empty when none fit. */
export type EmojiSearch = (query: string, limit: number) => Promise<readonly EmojiMatch[]>;

// Standard Slack emoji only: they render in every workspace with no lookup call.
const STANDARD_REACTIONS = [
  "thumbsup",
  "ok_hand",
  "eyes",
  "white_check_mark",
  "raised_hands",
  "tada",
  "joy",
  "heart",
  "pray",
  "wave",
  "saluting_face",
  "fire",
] as const;

const emojiReactionSchema = z.object({
  emoji: z
    .enum(STANDARD_REACTIONS)
    .describe(
      "Standard fallback: thumbsup = acknowledged; ok_hand = sounds good; eyes = noticed; white_check_mark = agreed/confirmed; raised_hands or tada = celebration; joy = funny; heart = appreciation; pray = thanks; wave = greeting; saluting_face = salute; fire = impressive.",
    ),
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Optional vibe, mood, or moment (for example "shipped it", "mind blown", or "thank you") used to find a custom workspace emoji.',
    ),
});

export type EmojiReactionRequest = z.infer<typeof emojiReactionSchema>;

const messageLocator = {
  message_ts: z
    .string()
    .trim()
    .optional()
    .describe(
      'Optional Slack timestamp of an earlier message in this channel to react to, e.g. "1751401594.001200". Omit to react to the message that triggered you.',
    ),
  message_url: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional Slack permalink (https://….slack.com/archives/C…/p…) of a message in this channel to react to. Use instead of message_ts.",
    ),
};

export const reactWithEmojiInputSchema = z.object({
  reactions: z
    .array(emojiReactionSchema)
    .min(1)
    .max(3)
    .describe("One to three distinct reactions, ordered from most to least fitting."),
  ...messageLocator,
});

export const removeEmojiReactionInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('Name of the emoji reaction you added, for example "tada".'),
  ...messageLocator,
});

const SLACK_TS = /^\d{10}\.\d{6}$/;
const SLACK_PERMALINK =
  /https?:\/\/[a-z0-9][a-z0-9-]*(?:\.enterprise)?\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?!\d)(?:\?[^\s>|]*)?/;

export type ReactionTarget = { ok: true; ts: string } | { ok: false; error: string };

/**
 * Picks the message a reaction lands on. With no locator it is `defaultTs`.
 * An explicit `message_ts` or permalink may only name a message in the
 * channel the turn runs in.
 */
export function resolveReactionTarget(options: {
  readonly channelId: string;
  readonly defaultTs?: string;
  readonly messageTs?: string;
  readonly messageUrl?: string;
}): ReactionTarget {
  const { channelId, defaultTs, messageTs, messageUrl } = options;
  if (messageUrl) {
    const match = SLACK_PERMALINK.exec(messageUrl);
    if (!match) {
      return {
        ok: false,
        error: "message_url is not a Slack permalink (https://…slack.com/archives/C…/p…).",
      };
    }
    const ts = `${match[2]}.${match[3]}`;
    if (match[1] !== channelId) {
      return { ok: false, error: "message_url must point to a message in the current channel." };
    }
    if (messageTs && messageTs !== ts) {
      return { ok: false, error: "message_ts and message_url name different messages." };
    }
    return { ok: true, ts };
  }
  if (messageTs) {
    if (!SLACK_TS.test(messageTs)) {
      return { ok: false, error: 'message_ts must look like "1751401594.001200".' };
    }
    return { ok: true, ts: messageTs };
  }
  if (!defaultTs) {
    return { ok: false, error: "No triggering message to target. Pass message_ts or message_url." };
  }
  return { ok: true, ts: defaultTs };
}

/** Adds one reaction, treating a duplicate as success. */
async function addReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<void> {
  const result = await client.reactions
    .add({ channel, name, timestamp })
    .catch((error: unknown) => slackError(error, "already_reacted"));
  if (!result.ok && result.error !== "already_reacted") {
    throw new Error(`Slack reactions.add failed: ${result.error ?? "unknown error"}`);
  }
}

/**
 * Removes one of the bot's own reactions; Slack only lets a token remove
 * reactions it added. Returns false when the reaction was already absent.
 */
export async function removeEmojiReaction(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  name: string,
): Promise<boolean> {
  const result = await client.reactions
    .remove({ channel, name: name.replace(/^:+|:+$/gu, ""), timestamp })
    .catch((error: unknown) => slackError(error, "no_reaction"));
  if (result.error === "no_reaction") return false;
  if (!result.ok) {
    throw new Error(`Slack reactions.remove failed: ${result.error ?? "unknown error"}`);
  }
  return true;
}

/** Turns a thrown Slack error with the `expected` code into a result; rethrows anything else. */
function slackError(error: unknown, expected: string): { ok: false; error: string } {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (data?.error === expected) return { ok: false, error: expected };
  throw error;
}

/**
 * Adds each requested reaction. A reaction with a `query` first asks
 * `searchEmoji` for a custom workspace emoji, falling back to its standard
 * `emoji` when the search finds none, repeats an earlier pick, or Slack
 * rejects it.
 */
export async function addEmojiReactions(
  client: SlackReactionClient,
  channel: string,
  timestamp: string,
  reactions: readonly EmojiReactionRequest[],
  searchEmoji?: EmojiSearch,
): Promise<{ reacted: string[]; failed: number }> {
  const reacted: string[] = [];
  let failed = 0;

  for (const reaction of reactions) {
    let name: string = reaction.emoji;
    if (reaction.query && searchEmoji) {
      const matches = await searchEmoji(reaction.query, reactions.length);
      const match = matches.find((candidate) => !reacted.includes(candidate.name));
      if (match) name = match.name;
    }
    if (reacted.includes(name)) {
      name = reaction.emoji;
      if (reacted.includes(name)) continue;
    }

    try {
      await addReaction(client, channel, timestamp, name);
    } catch (error) {
      if (name === reaction.emoji || reacted.includes(reaction.emoji)) {
        failed++;
        console.warn("Slack emoji reaction failed", { emoji: name, error });
        continue;
      }
      try {
        await addReaction(client, channel, timestamp, reaction.emoji);
        name = reaction.emoji;
      } catch (fallbackError) {
        failed++;
        console.warn("Slack custom and fallback emoji reactions failed", {
          customEmoji: name,
          fallbackEmoji: reaction.emoji,
          error: fallbackError,
        });
        continue;
      }
    }
    reacted.push(name);
  }

  return { reacted, failed };
}
