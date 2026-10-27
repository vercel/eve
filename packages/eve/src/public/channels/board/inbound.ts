import type { SessionAuthContext } from "#channel/types.js";
import { readLimitedBytes } from "#internal/attachments/limited-read.js";
import type { BoardClient, BoardMessage } from "#public/channels/board/client.js";
import type { FetchFileResult } from "#shared/channel-definition.js";
import type { MessageContent } from "#shared/message-content.js";

// Actor kinds a person stands behind; the rest are agents, deployments, and workflows.
const PERSON_KINDS = new Set(["person", "external"]);

/** A board message's thread root: the message ID replies in the thread name. */
export function boardThreadId(message: Pick<BoardMessage, "id" | "re">): string {
  return message.re ?? message.id;
}

/**
 * The session address for a board message's thread: the board's thread key, since message IDs
 * restart on another board or after a store reset and would reach another thread's session.
 */
export function boardSessionAddress(message: Pick<BoardMessage, "thread">): string {
  return `thread:${message.thread}`;
}

/**
 * Projects a board message's author into an eve {@link SessionAuthContext}. The board verified
 * the author and never takes it from a request body, so `principalId` is the board's actor ID,
 * such as `slack:user:U0456` or `vercel:user:u_abc+claude`. Reuse it when composing `onMessage`.
 */
export function defaultBoardAuth(
  message: BoardMessage,
  board: { readonly url: string },
): SessionAuthContext {
  const kind = message.author?.kind ?? "unknown";
  return {
    attributes: {
      actor_kind: kind,
      board_url: board.url,
      channel: message.channel,
      message_id: message.id,
      principal: message.by.principal,
      ...(message.by.profile !== null && { profile: message.by.profile }),
      thread_id: boardThreadId(message),
    },
    authenticator: "board-watcher",
    issuer: board.url,
    principalId: message.by.actor,
    principalType: PERSON_KINDS.has(kind) ? "user" : "service",
    subject: message.author?.handle ?? message.by.actor,
  };
}

/** Where a board message sits, for the model. */
export function formatBoardContext(message: BoardMessage, board: { readonly url: string }): string {
  const author = message.author?.handle ?? message.by.actor;
  const where =
    message.re === null
      ? `started thread #${message.id}`
      : `replied in thread #${message.re} (message #${message.id})`;
  return [
    `Board message: @${author} ${where} in channel "${message.channel}" on ${board.url}.`,
    "Your reply is posted in that board thread, which may be synced to Slack, GitHub, or Linear.",
  ].join(" ");
}

/** The message's text, with each attachment as a file the channel's `fetchFile` downloads. */
export function boardMessageContent(
  message: BoardMessage,
  board: { readonly url: string },
): MessageContent {
  if (message.attachments.length === 0) return message.text;
  return [
    ...(message.text.length > 0 ? [{ type: "text" as const, text: message.text }] : []),
    ...message.attachments.map((attachment) => ({
      type: "file" as const,
      data: new URL(boardAttachmentUrl(board.url, attachment.id)),
      filename: attachment.name,
      mediaType: attachment.type,
    })),
  ];
}

function boardAttachmentUrl(boardUrl: string, attachmentId: string): string {
  return `${boardUrl}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Downloads a board attachment eve staged, or `null` for a link that isn't this board's. */
export async function fetchBoardAttachment(
  url: string,
  client: BoardClient,
  maxBytes: number,
): Promise<FetchFileResult | null> {
  const prefix = `${client.url}/attachments/`;
  if (!url.startsWith(prefix)) return null;
  const attachmentId = decodeURIComponent(url.slice(prefix.length));
  if (attachmentId.length === 0 || attachmentId.includes("/")) return null;
  const response = await client.download(attachmentId);
  return {
    bytes: await readLimitedBytes(response, maxBytes, "board"),
    mediaType: response.headers.get("content-type") ?? undefined,
  };
}
