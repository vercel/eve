import type { ChannelWatchKey } from "./store.ts";

export type ChannelWatchAuthor =
  | { readonly kind: "missing" }
  | { readonly kind: "self" }
  | { readonly kind: "other"; readonly isBot?: boolean };

export type ChannelWatchDropReason =
  | "missing_author"
  | "bot_author"
  | "ignored_subtype"
  | "thread_reply"
  | "empty_text";

export type ChannelWatchAdmissionDropReason =
  | ChannelWatchDropReason
  | "not_watched";

export interface ChannelWatchMessage {
  readonly author: ChannelWatchAuthor;
  readonly channelId: string;
  readonly subtype?: string;
  readonly teamId: string;
  readonly threadTs?: string;
  readonly ts: string;
  readonly visibleText: string;
}

export type ChannelWatchEvaluation =
  | { readonly kind: "eligible" }
  | { readonly kind: "drop"; readonly reason: ChannelWatchDropReason };

export type ChannelWatchAdmission =
  | {
      readonly kind: "admit";
      readonly message: ChannelWatchMessage;
      readonly key: ChannelWatchKey;
      readonly title: string;
    }
  | { readonly kind: "drop"; readonly reason: ChannelWatchAdmissionDropReason };

export interface ChannelWatchMembership {
  has: (key: ChannelWatchKey) => Promise<boolean>;
}

const ALLOWED_SUBTYPES: ReadonlySet<string> = new Set([
  "file_share",
  "bot_message",
]);
const LINE_SPLIT = /\r?\n/u;

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(LINE_SPLIT)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return text.trim();
}

export function evaluateChannelWatchMessage(
  message: ChannelWatchMessage
): ChannelWatchEvaluation {
  if (message.threadTs && message.threadTs !== message.ts) {
    return { kind: "drop", reason: "thread_reply" };
  }
  if (message.subtype && !ALLOWED_SUBTYPES.has(message.subtype)) {
    return { kind: "drop", reason: "ignored_subtype" };
  }
  if (message.author.kind === "missing" && message.subtype !== "bot_message") {
    return { kind: "drop", reason: "missing_author" };
  }
  if (message.author.kind === "self") {
    return { kind: "drop", reason: "bot_author" };
  }
  if (!message.visibleText.trim()) {
    return { kind: "drop", reason: "empty_text" };
  }
  return { kind: "eligible" };
}

export async function admitChannelWatchMessage(
  message: ChannelWatchMessage,
  membership: ChannelWatchMembership
): Promise<ChannelWatchAdmission> {
  const evaluation = evaluateChannelWatchMessage(message);
  if (evaluation.kind === "drop") {
    return evaluation;
  }
  if (!(message.teamId && message.channelId)) {
    return { kind: "drop", reason: "not_watched" };
  }

  const key = { channelId: message.channelId, teamId: message.teamId };
  return (await membership.has(key))
    ? {
        key,
        kind: "admit",
        message,
        title: firstNonEmptyLine(message.visibleText),
      }
    : { kind: "drop", reason: "not_watched" };
}
