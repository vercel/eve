/**
 * Native Slack Web API surface used by the channel.
 *
 * Exposes two handles to author code via `ctx`:
 *
 * - {@link SlackThread}: operations scoped to the bound thread.
 *   `ctx.thread.post(...)` reads as "post a reply to this thread".
 * - {@link SlackHandle}: Slack identity + raw API escape hatch.
 *   `ctx.slack.request(...)` reads as "raw Slack API call, possibly
 *   not the bound thread".
 *
 * Kept in a thin module so the channel core (`slackChannel.ts`), the
 * interaction handler (`interactions.ts`), and the default event
 * handlers (`defaults.ts`) can all share the same low-level helpers
 * without depending on each other.
 */

import { isCardElement, type CardElement, type FileUpload } from "#compiled/chat/index.js";

import { createLogger, logError } from "#internal/logging.js";
import { encodeSlackApiBody } from "#public/channels/slack/api-encoding.js";
import { cardToBlocks, cardToFallbackText } from "#public/channels/slack/blocks.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";
import {
  gfmToSlackMrkdwn,
  rewriteBareMentions,
  slackMrkdwnToGfm,
} from "#public/channels/slack/mrkdwn.js";

const log = createLogger("slack.api");

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that returns one. The function form
 * supports secret-manager lookups and credential rotation.
 */
export type SlackBotToken = string | (() => string | Promise<string>);

/**
 * Builds the channel-local continuation token (`<channelId>:<threadTs>`).
 * The runtime's `send()` later namespaces it with the channel's
 * path-derived name (`<channelName>:<channelId>:<threadTs>`). `threadTs`
 * may be empty for threadless sessions; the channel auto-anchors on its
 * first post.
 */
export function slackContinuationToken(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

/**
 * Materializes a {@link SlackBotToken} to a string, falling back to
 * `process.env.SLACK_BOT_TOKEN`. Throws when neither is set.
 */
export async function resolveSlackBotToken(token?: SlackBotToken): Promise<string> {
  const source = token ?? process.env.SLACK_BOT_TOKEN;
  if (!source) throw new Error("SLACK_BOT_TOKEN is required.");
  return typeof source === "function" ? await source() : source;
}

/**
 * Slack Web API JSON response envelope. `ok` signals success, `error`
 * carries Slack's error code on failure, and method-specific fields pass
 * through verbatim. Callers inspect `ok` themselves.
 */
export interface SlackApiResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

/**
 * Low-level POST to a Slack Web API method, signed with the bot token
 * and form-encoded. Form is the only safe default: Slack's JSON support
 * is partial (e.g. `conversations.replies` rejects JSON). Returns the
 * raw JSON response; callers inspect `response.ok` themselves.
 */
export async function callSlackApi(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly operation: string;
  readonly body: unknown;
}): Promise<SlackApiResponse> {
  const token = await resolveSlackBotToken(input.botToken);
  const encoded = encodeSlackApiBody(input.body);
  const response = await fetch(`https://slack.com/api/${input.operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": encoded.contentType,
    },
    body: encoded.body,
  });
  return response.json() as Promise<SlackApiResponse>;
}

/**
 * Builds the `request(op, body)` Slack API caller installed on every
 * {@link SlackHandle}. Resolves the bot token at call time so rotated
 * credentials are picked up without rebuilding the binding.
 */
function createSlackRequester(
  botToken: SlackBotToken | undefined,
): (operation: string, body: unknown) => Promise<SlackApiResponse> {
  return (operation, body) => callSlackApi({ botToken, operation, body });
}

/**
 * Result of {@link SlackThread.post} / {@link SlackThread.postEphemeral}.
 * The posted message's Slack `ts` is exposed under `id` so callers can
 * target the same message with a follow-up `chat.update`.
 */
export interface SlackPostedMessage {
  /** Slack message `ts`. Empty when Slack did not return one. */
  readonly id: string;
  /** Slack's raw JSON response. */
  readonly raw: SlackApiResponse;
}

/**
 * Optional `files` field shared by every {@link SlackPostInput} variant.
 *
 * When non-empty:
 * - The channel uploads each file via Slack's modern
 *   `files.getUploadURLExternal` → POST bytes → `files.completeUploadExternal`
 *   flow.
 * - For `{ markdown }` / `{ text }`: the text becomes the file post's
 *   `initial_comment`, producing a single Slack message with text and
 *   files.
 * - For `{ blocks }` / `{ card }`: the structured message lands first
 *   via `chat.postMessage`, then the files are uploaded as a
 *   follow-up message in the same thread. Slack has no native way to
 *   attach arbitrary files inside a Block Kit message, so the two
 *   land as separate posts in the same thread.
 */
interface SlackPostWithFiles {
  readonly files?: readonly FileUpload[];
}

/**
 * Inbound shape for {@link SlackThread.post} and
 * {@link SlackThread.postEphemeral}.
 *
 * - `{ markdown }`: Slack's native `markdown_text` field (headings,
 *   tables, lists, etc.).
 * - `{ text }`: Slack's `text` field, interpreted as Slack mrkdwn.
 * - `{ blocks, text? }`: raw Block Kit blocks with optional fallback
 *   text, for layout markdown cannot express.
 * - `{ card, fallbackText? }`: a {@link CardElement} (from the
 *   re-exported `Card`/`Actions`/`Button`/... factories), converted to
 *   Block Kit internally. `fallbackText` overrides the text extracted
 *   from card children.
 *
 * Every variant also accepts an optional `files` field.
 */
export type SlackPostInput = SlackPostWithFiles &
  (
    | { readonly markdown: string }
    | { readonly text: string }
    | { readonly blocks: readonly unknown[]; readonly text?: string }
    | { readonly card: CardElement; readonly fallbackText?: string }
  );

/**
 * Options for {@link SlackHandle.uploadFiles}. Defaults follow the bound
 * thread.
 */
export interface SlackUploadFilesOptions {
  /** Override the channel id. Defaults to the binding's `channelId`. */
  readonly channelId?: string;
  /** Override the thread ts. Defaults to the binding's `threadTs`. */
  readonly threadTs?: string;
  /**
   * Optional text shown above the files in the thread. Slack
   * interprets this as mrkdwn.
   */
  readonly initialComment?: string;
}

/**
 * Result of one {@link SlackHandle.uploadFiles} call.
 */
export interface SlackUploadFilesResult {
  /** Slack file ids in upload order. */
  readonly fileIds: readonly string[];
  /** Slack's raw `files.completeUploadExternal` response. */
  readonly raw: SlackApiResponse;
}

/**
 * One thread message returned by {@link SlackThread.refresh} /
 * {@link SlackThread.recentMessages}.
 */
export interface SlackThreadMessage {
  readonly text: string;
  readonly markdown: string;
  readonly user: string | undefined;
  readonly botId: string | undefined;
  readonly ts: string;
  readonly threadTs: string;
  readonly isMe: boolean;
  readonly raw: Record<string, unknown>;
}

/**
 * Thread-scoped Slack handle exposed at `ctx.thread`. Every method
 * targets the thread bound to the current event. For raw calls against a
 * different channel or thread, use {@link SlackHandle.request} on
 * `ctx.slack`.
 */
export interface SlackThread {
  /** Recently fetched thread messages. Populated by {@link refresh}. */
  readonly recentMessages: readonly SlackThreadMessage[];

  /**
   * Post a reply to this thread.
   *
   * Bare-form shortcuts: `string` becomes `{ markdown }` (so `**bold**` /
   * `[label](url)` render); a {@link CardElement} from `Card(...)`
   * becomes `{ card }`. Otherwise pass a {@link SlackPostInput}
   * explicitly, any variant of which may carry `files`.
   *
   * With `files`, the channel runs Slack's three-step upload flow and
   * either attaches them to this message (markdown / text variants) or
   * posts them as a follow-up in the same thread (blocks / card
   * variants).
   */
  post(message: string | CardElement | SlackPostInput): Promise<SlackPostedMessage>;

  /**
   * Post an ephemeral reply (Slack's `chat.postEphemeral`) visible only
   * to one user in this thread. Accepts the same bare forms and
   * {@link SlackPostInput} variants as {@link post}. The `files` field is
   * ignored: Slack does not support file uploads on ephemeral messages.
   */
  postEphemeral(
    userId: string,
    message: string | CardElement | SlackPostInput,
  ): Promise<SlackPostedMessage>;

  /**
   * Post a direct message to one user — their IM conversation with the
   * bot, outside this thread. Opens the conversation via Slack's
   * `conversations.open` (requires the `im:write` scope) and posts with
   * the same bare forms and {@link SlackPostInput} variants as
   * {@link post}. The `files` field is ignored.
   */
  postDirectMessage(
    userId: string,
    message: string | CardElement | SlackPostInput,
  ): Promise<SlackPostedMessage>;

  /**
   * Show a typing/status indicator in this thread via Slack's
   * `assistant.threads.setStatus`. Called with no argument, clears the
   * indicator (empty status). Failures are logged and swallowed: the
   * indicator is a UX nicety, never a reason to fail a turn.
   */
  startTyping(status?: string): Promise<void>;

  /**
   * Fetch the latest replies in this thread into {@link recentMessages}
   * via `conversations.replies` (50-message cap). Failures are logged and
   * swallowed, leaving `recentMessages` empty.
   */
  refresh(): Promise<void>;

  /**
   * Returns the Slack mention syntax for a user (`<@U123>`), suitable
   * for embedding in a {@link post} payload.
   */
  mentionUser(userId: string): string;
}

/**
 * Slack identity + raw-API handle exposed at `ctx.slack`, for calls that
 * escape the bound thread: posting in a different channel, looking up
 * users, raw Web API calls, and low-level file uploads. Thread-scoped
 * operations (post, startTyping, refresh) live on {@link SlackThread}
 * (`ctx.thread`).
 */
export interface SlackHandle {
  /** Slack channel id. */
  readonly channelId: string;
  /** Slack thread root ts (or the message ts when not in a thread). */
  readonly threadTs: string;
  /** Slack team id, when the inbound event carried one. */
  readonly teamId: string | undefined;

  /**
   * POST to a Slack Web API method. Returns Slack's raw JSON response.
   * Callers must check `response.ok` themselves.
   */
  request(operation: string, body: unknown): Promise<SlackApiResponse>;

  /**
   * Upload files via Slack's modern external-upload flow, returning the
   * resolved file ids and the raw `files.completeUploadExternal`
   * response. The bot token is resolved at call time so rotated
   * credentials are picked up. Empty `files` is a no-op returning
   * `{ fileIds: [], raw: { ok: true } }`.
   *
   * Prefer `ctx.thread.post({ ..., files })` for thread-scoped uploads.
   * This is the escape hatch for targeting a different channel/thread or
   * pre-staging files without an accompanying message.
   */
  uploadFiles(
    files: readonly FileUpload[],
    options?: SlackUploadFilesOptions,
  ): Promise<SlackUploadFilesResult>;
}

/**
 * The `{ thread, slack }` pair exposed through `ctx` to every mention
 * handler, interaction handler, and event handler. Returned by
 * {@link buildSlackBinding}.
 */
interface SlackBinding {
  readonly thread: SlackThread;
  readonly slack: SlackHandle;
}

/**
 * Constructs the `{ thread, slack }` pair.
 *
 * Auto-anchor: when the binding starts without a `threadTs`, the first
 * `chat.postMessage` adopts its own `ts` as the thread root, updating the
 * live `threadTs` and firing `onThreadTsChanged` so the caller can
 * persist the anchor. Ephemerals and files-only posts do not anchor.
 */
export function buildSlackBinding(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly threadTs: string;
  readonly teamId: string | undefined;
  readonly onThreadTsChanged?: (ts: string) => void;
}): SlackBinding {
  const request = createSlackRequester(input.botToken);
  const messages: SlackThreadMessage[] = [];
  let currentThreadTs = input.threadTs;

  function handleMessageTs(ts: string): void {
    if (currentThreadTs || ts === currentThreadTs) return;
    currentThreadTs = ts;
    input.onThreadTsChanged?.(ts);
  }

  async function uploadFiles(
    files: readonly FileUpload[],
    options?: SlackUploadFilesOptions,
  ): Promise<SlackUploadFilesResult> {
    if (files.length === 0) {
      return { fileIds: [], raw: { ok: true } as SlackApiResponse };
    }
    const channelId = options?.channelId ?? input.channelId;
    const threadTs = options?.threadTs ?? currentThreadTs;
    const token = await resolveSlackBotToken(input.botToken);

    const fileIds: string[] = [];
    for (const file of files) {
      const bytes = await readFileBytes(file.data);
      const getUrl = await callSlackApi({
        botToken: input.botToken,
        operation: "files.getUploadURLExternal",
        body: {
          filename: file.filename,
          length: bytes.byteLength,
        },
      });
      if (
        getUrl.ok !== true ||
        typeof getUrl.upload_url !== "string" ||
        typeof getUrl.file_id !== "string"
      ) {
        throw new Error(
          `Slack files.getUploadURLExternal failed: ${getUrl.error ?? "unknown_error"}`,
        );
      }
      const uploadResponse = await fetch(getUrl.upload_url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/octet-stream",
        },
        body: bytes,
      });
      if (!uploadResponse.ok) {
        throw new Error(
          `Slack upload POST returned HTTP ${uploadResponse.status} for ${file.filename}.`,
        );
      }
      fileIds.push(getUrl.file_id);
    }

    const completeBody: Record<string, unknown> = {
      files: files.map((file, i) => ({ id: fileIds[i], title: file.filename })),
    };
    if (channelId) completeBody.channel_id = channelId;
    if (threadTs) completeBody.thread_ts = threadTs;
    if (options?.initialComment) completeBody.initial_comment = options.initialComment;

    const complete = await callSlackApi({
      botToken: input.botToken,
      operation: "files.completeUploadExternal",
      body: completeBody,
    });
    if (complete.ok !== true) {
      throw new Error(
        `Slack files.completeUploadExternal failed: ${complete.error ?? "unknown_error"}`,
      );
    }
    return { fileIds, raw: complete };
  }

  const thread: SlackThread = {
    recentMessages: messages,
    async post(rawMessage) {
      const message = normalizePostInput(rawMessage);
      const files = message.files ?? [];
      const hasStructured = "blocks" in message || "card" in message;

      // markdown / text + files: single Slack message with files attached
      // via files.completeUploadExternal's initial_comment.
      if (files.length > 0 && !hasStructured) {
        const comment =
          "markdown" in message
            ? rewriteBareMentions(gfmToSlackMrkdwn(message.markdown))
            : "text" in message
              ? rewriteBareMentions(message.text)
              : undefined;
        const result = await uploadFiles(files, { initialComment: comment });
        const id =
          Array.isArray(result.raw.files) && result.raw.files.length > 0
            ? String((result.raw.files[0] as { id?: unknown }).id ?? "")
            : "";
        return { id, raw: result.raw };
      }

      const body = buildPostMessageBody(message, input.channelId, currentThreadTs);
      const response = await request("chat.postMessage", body);
      if (response.ok !== true) {
        throw new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown_error"}`);
      }
      const id = typeof response.ts === "string" ? response.ts : "";
      handleMessageTs(id);

      // blocks / card + files: structured message lands first, then upload
      // files as a follow-up post in the same thread.
      if (files.length > 0 && hasStructured) {
        try {
          await uploadFiles(files);
        } catch (error) {
          log.warn("file upload after structured post failed", { error });
        }
      }
      return { id, raw: response };
    },
    async postEphemeral(userId, rawMessage) {
      const message = normalizePostInput(rawMessage);
      const body = buildPostMessageBody(message, input.channelId, currentThreadTs);
      body.user = userId;
      const response = await request("chat.postEphemeral", body);
      if (response.ok !== true) {
        throw new Error(`Slack chat.postEphemeral failed: ${response.error ?? "unknown_error"}`);
      }
      const id = typeof response.message_ts === "string" ? response.message_ts : "";
      return { id, raw: response };
    },
    async postDirectMessage(userId, rawMessage) {
      const open = await request("conversations.open", { users: userId });
      const imChannelId =
        open.ok === true ? (open.channel as { id?: unknown } | undefined)?.id : undefined;
      if (typeof imChannelId !== "string" || imChannelId.length === 0) {
        throw new Error(`Slack conversations.open failed: ${open.error ?? "unknown_error"}`);
      }
      const message = normalizePostInput(rawMessage);
      const body = buildPostMessageBody(message, imChannelId, "");
      const response = await request("chat.postMessage", body);
      if (response.ok !== true) {
        throw new Error(`Slack chat.postMessage failed: ${response.error ?? "unknown_error"}`);
      }
      return { id: typeof response.ts === "string" ? response.ts : "", raw: response };
    },
    async startTyping(status) {
      if (!input.channelId || !currentThreadTs) return;
      try {
        const normalizedStatus = status === undefined ? "" : truncateTypingStatus(status);
        const body: Record<string, unknown> = {
          channel_id: input.channelId,
          thread_ts: currentThreadTs,
          status: normalizedStatus,
        };
        if (normalizedStatus.length > 0) {
          body.loading_messages = [normalizedStatus];
        }
        const response = await request("assistant.threads.setStatus", body);
        if (response.ok !== true) {
          log.warn("assistant.threads.setStatus returned not-ok", {
            error: response.error,
          });
        }
      } catch (error) {
        logError(log, "startTyping threw — swallowed", error, { channelId: input.channelId });
      }
    },
    async refresh() {
      messages.length = 0;
      if (!input.channelId || !currentThreadTs) return;
      try {
        const response = await request("conversations.replies", {
          channel: input.channelId,
          ts: currentThreadTs,
          limit: 50,
        });
        if (response.ok !== true || !Array.isArray(response.messages)) {
          log.warn("conversations.replies returned not-ok", { error: response.error });
          return;
        }
        for (const raw of response.messages as Record<string, unknown>[]) {
          messages.push(parseThreadMessage(raw, currentThreadTs));
        }
      } catch (error) {
        logError(log, "refresh threw — swallowed", error, { channelId: input.channelId });
      }
    },
    mentionUser(userId) {
      return `<@${userId}>`;
    },
  };

  const slack: SlackHandle = {
    channelId: input.channelId,
    get threadTs() {
      return currentThreadTs;
    },
    teamId: input.teamId,
    request,
    uploadFiles,
  };

  return { thread, slack };
}

/**
 * Coerces the ergonomic bare forms of `SlackThread.post` / `postEphemeral`
 * into the explicit {@link SlackPostInput} discriminated union the
 * implementation works with.
 *
 * - `string` → `{ markdown }` so call sites like `ctx.thread.post(event.message)`
 *   render through Slack's markdown converter.
 * - {@link CardElement} → `{ card }` so call sites like
 *   `ctx.thread.post(Card({...}))` go through the Block Kit converter.
 * - Anything else is assumed to already be a {@link SlackPostInput}.
 */
function normalizePostInput(message: string | CardElement | SlackPostInput): SlackPostInput {
  if (typeof message === "string") return { markdown: message };
  if (isCardElement(message)) return { card: message };
  return message;
}

function buildPostMessageBody(
  message: SlackPostInput,
  channelId: string,
  threadTs: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    channel: channelId,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (threadTs) base.thread_ts = threadTs;

  if ("card" in message) {
    base.blocks = cardToBlocks(message.card);
    base.text = message.fallbackText ?? cardToFallbackText(message.card);
    return base;
  }
  if ("blocks" in message) {
    base.blocks = message.blocks;
    if (message.text !== undefined) base.text = message.text;
    return base;
  }
  if ("markdown" in message) {
    base.markdown_text = rewriteBareMentions(message.markdown);
    return base;
  }
  base.text = rewriteBareMentions(message.text);
  return base;
}

function parseThreadMessage(
  raw: Record<string, unknown>,
  threadRootTs: string,
): SlackThreadMessage {
  const text = typeof raw.text === "string" ? raw.text : "";
  const ts = typeof raw.ts === "string" ? raw.ts : "";
  const threadTs = typeof raw.thread_ts === "string" ? raw.thread_ts : threadRootTs;
  const user = typeof raw.user === "string" ? raw.user : undefined;
  const botId = typeof raw.bot_id === "string" ? raw.bot_id : undefined;
  return {
    text,
    markdown: slackMrkdwnToGfm(text),
    user,
    botId,
    ts,
    threadTs,
    isMe: botId !== undefined,
    raw,
  };
}

/**
 * Normalize a {@link FileUpload.data} value (`Buffer | Blob | ArrayBuffer`) to
 * a contiguous `Buffer` we can both POST and length-prefix without
 * holding two copies of the payload in memory.
 */
async function readFileBytes(data: FileUpload["data"]): Promise<Buffer> {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error("FileUpload.data must be a Buffer, ArrayBuffer, or Blob.");
}
