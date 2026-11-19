import type { SessionAuthContext } from "#channel/types.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import type { BoardClaimedTask, BoardClient, BoardMessage } from "#public/channels/board/client.js";
import type { FetchFileResult } from "#shared/channel-definition.js";
import type { MessageContent } from "#shared/message-content.js";

const PERSON_KINDS = new Set(["person", "external"]);
const ATTACHMENT_URL = "board-attachment:";

/** A board message's thread root: the message ID replies in the thread name. */
export function boardThreadId(message: Pick<BoardMessage, "id" | "re">): string {
  return message.re ?? message.id;
}

export function boardSessionAddress(
  watcher: string,
  message: Pick<BoardMessage, "thread">,
): string {
  return `${watcher}:thread:${message.thread}`;
}

/**
 * Projects a board message's author into an eve {@link SessionAuthContext}. The board verified
 * the author and never takes it from a request body, so `principalId` is the board's actor ID,
 * such as `vercel:user:u_abc+claude` or a synced Slack user's. Reuse it when composing `onMessage`.
 */
export function defaultBoardAuth(
  message: BoardMessage,
  board: { readonly name?: string; readonly watcher?: string },
): SessionAuthContext {
  const kind = message.author?.kind ?? "unknown";
  return {
    attributes: {
      actor_kind: kind,
      board: board.name ?? "default",
      channel: message.channel,
      message_id: message.id,
      principal: message.by.principal,
      ...(message.by.profile !== null && { profile: message.by.profile }),
      thread_id: boardThreadId(message),
      ...(board.watcher !== undefined && { watcher: board.watcher }),
    },
    authenticator: "board-watcher",
    issuer: "vercel-board",
    principalId: message.by.actor,
    principalType: PERSON_KINDS.has(kind) ? "user" : "service",
    subject: message.author?.handle ?? message.by.actor,
  };
}

function authorOf(message: BoardMessage): string {
  return message.author?.handle ?? message.by.actor;
}

export function formatBoardContext(message: BoardMessage): string {
  const where =
    message.re === null
      ? `started thread #${message.id}`
      : `replied in thread #${message.re} (message #${message.id})`;
  return [
    `Board message: @${authorOf(message)} ${where} in channel "${message.channel}".`,
    "Your final message is posted as your reply in that board thread, which may be synced to Slack, GitHub, or Linear, so don't also post it there with a board tool.",
  ].join(" ");
}

export function formatTaskContext(claim: BoardClaimedTask): string {
  return [
    `You hold board task #${claim.task.id} in channel "${claim.task.channel}", posted by @${authorOf(claim.task)}. Its root message is the brief.`,
    "Read the whole thread with the board read tool first: it holds earlier attempts, questions, and answers.",
    "Your final message reaches nobody. Post progress with the board reply or note tools, then settle the task before you stop: complete_task with the result, block_task with the one question a person must answer, fail_task with why, or release_task to give it back.",
    "A turn that ends without settling the task holds it for a person.",
  ].join(" ");
}

export function formatTaskFollowUpContext(message: BoardMessage): string {
  return `Board message: @${authorOf(message)} replied in your task's thread #${message.re ?? message.id} (message #${message.id}). You still hold the task: settle it with a task tool before you stop.`;
}

export function boardMessageContent(message: BoardMessage): MessageContent {
  if (message.attachments.length === 0) return message.text;
  return [
    ...(message.text.length > 0 ? [{ type: "text" as const, text: message.text }] : []),
    ...message.attachments.map((attachment) => ({
      type: "file" as const,
      data: new URL(`${ATTACHMENT_URL}${encodeURIComponent(attachment.id)}`),
      filename: attachment.name,
      mediaType: attachment.type,
    })),
  ];
}

export async function fetchBoardAttachment(
  url: string,
  client: BoardClient,
  maxBytes: number,
): Promise<FetchFileResult | null> {
  if (!url.startsWith(ATTACHMENT_URL)) return null;
  const attachmentId = decodeURIComponent(url.slice(ATTACHMENT_URL.length));
  if (attachmentId.length === 0 || attachmentId.includes("/")) return null;
  const response = await client.download(attachmentId);
  return {
    bytes: await readLimitedBytes(response, maxBytes, "board"),
    mediaType: response.headers.get("content-type") ?? undefined,
  };
}
