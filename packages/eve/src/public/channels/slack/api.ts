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

import {
  callSlackApi as callSlackApiPrimitive,
  fetchSlackThreadReplies,
  postSlackEphemeral,
  postSlackMessage,
  resolveSlackBotToken as resolveSlackBotTokenPrimitive,
  uploadSlackFiles,
  type SlackApiOptions,
  type SlackApiResponse as SlackPrimitiveApiResponse,
  type SlackBotToken as SlackPrimitiveBotToken,
  type SlackFileUpload,
  type SlackMessageOptions,
} from "#compiled/@chat-adapter/slack/api.js";
import { isCardElement, type CardElement, type FileUpload } from "#compiled/chat/index.js";

import { createLogger, logError } from "#internal/logging.js";
import { cardToBlocks, cardToFallbackText } from "#public/channels/slack/blocks.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";
import { slackMrkdwnToGfm } from "#public/channels/slack/mrkdwn.js";

const log = createLogger("slack.api");

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that returns one. The function form
 * supports secret-manager lookups and credential rotation.
 */
export type SlackBotToken = SlackPrimitiveBotToken;

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
  return resolveSlackBotTokenPrimitive(source);
}

/**
 * Slack Web API JSON response envelope. `ok` signals success, `error`
 * carries Slack's error code on failure, and method-specific fields pass
 * through verbatim. Callers inspect `ok` themselves.
 */
export type SlackApiResponse = SlackPrimitiveApiResponse;

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
  return callSlackApiPrimitive(
    input.operation,
    normalizeSlackApiBody(input.body),
    createSlackApiOptions(input.botToken),
  );
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
 * - For `{ text }`: the text becomes the file post's `initial_comment`,
 *   producing a single Slack message with text and files. Slack
 *   interprets `initial_comment` as mrkdwn.
 * - For `{ markdown }` / `{ blocks }` / `{ card }`: the message lands
 *   first via `chat.postMessage`, then the files are uploaded as a
 *   follow-up message in the same thread. Slack has no native way to
 *   attach arbitrary files inside those message surfaces, and
 *   `initial_comment` cannot render Slack's full Markdown table/header
 *   support.
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
   * With `files`, the channel runs Slack's three-step upload flow. The
   * `{ text }` variant attaches files with the text as the upload
   * comment; `{ markdown }`, `{ blocks }`, and `{ card }` post the
   * message first and upload files as a follow-up in the same thread.
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
 * persist the anchor. Ephemerals and upload-only file posts do not
 * anchor.
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
    const channelId = options?.channelId ?? input.channelId;
    const threadTs = options?.threadTs ?? currentThreadTs;
    return uploadSlackFiles(files.map(toSlackFileUpload), {
      ...createSlackApiOptions(input.botToken),
      channelId: channelId || undefined,
      initialComment: options?.initialComment,
      threadTs: threadTs || undefined,
    });
  }

  const thread: SlackThread = {
    recentMessages: messages,
    async post(rawMessage) {
      const message = normalizePostInput(rawMessage);
      const files = message.files ?? [];
      const hasStructured = "blocks" in message || "card" in message;
      const shouldPostBeforeFiles = hasStructured || "markdown" in message;

      // text + files: single Slack message with files attached via
      // files.completeUploadExternal's mrkdwn-only initial_comment.
      if (files.length > 0 && !shouldPostBeforeFiles) {
        const comment = "text" in message ? message.text : undefined;
        const result = await uploadFiles(files, { initialComment: comment });
        const id =
          Array.isArray(result.raw.files) && result.raw.files.length > 0
            ? String((result.raw.files[0] as { id?: unknown }).id ?? "")
            : "";
        return { id, raw: result.raw };
      }

      const response = await postSlackMessage(
        buildPostMessageOptions(message, input.channelId, currentThreadTs, input.botToken),
      );
      const id = response.id;
      handleMessageTs(id);

      // markdown / blocks / card + files: message lands first, then
      // files upload as a follow-up post in the same thread.
      if (files.length > 0 && shouldPostBeforeFiles) {
        try {
          await uploadFiles(files);
        } catch (error) {
          log.warn("file upload after message post failed", { error });
        }
      }
      return { id, raw: response.raw };
    },
    async postEphemeral(userId, rawMessage) {
      const message = normalizePostInput(rawMessage);
      const response = await postSlackEphemeral({
        ...buildPostMessageOptions(message, input.channelId, currentThreadTs, input.botToken),
        user: userId,
      });
      return { id: response.id, raw: response.raw };
    },
    async postDirectMessage(userId, rawMessage) {
      const open = await request("conversations.open", { users: userId });
      const imChannelId =
        open.ok === true ? (open.channel as { id?: unknown } | undefined)?.id : undefined;
      if (typeof imChannelId !== "string" || imChannelId.length === 0) {
        throw new Error(`Slack conversations.open failed: ${open.error ?? "unknown_error"}`);
      }
      const message = normalizePostInput(rawMessage);
      const response = await postSlackMessage(
        buildPostMessageOptions(message, imChannelId, "", input.botToken),
      );
      return { id: response.id, raw: response.raw };
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
        const response = await fetchSlackThreadReplies({
          ...createSlackApiOptions(input.botToken),
          channel: input.channelId,
          limit: 50,
          ts: currentThreadTs,
        });
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

function buildPostMessageOptions(
  message: SlackPostInput,
  channelId: string,
  threadTs: string,
  botToken: SlackBotToken | undefined,
): SlackMessageOptions {
  const base: SlackMessageOptions = {
    ...createSlackApiOptions(botToken),
    channel: channelId,
    threadTs: threadTs || undefined,
    unfurlLinks: false,
    unfurlMedia: false,
  };

  if ("card" in message) {
    base.blocks = cardToBlocks(message.card);
    base.text = message.fallbackText ?? cardToFallbackText(message.card);
    return base;
  }
  if ("blocks" in message) {
    base.blocks = [...message.blocks];
    if (message.text !== undefined) base.text = message.text;
    return base;
  }
  if ("markdown" in message) {
    base.markdownText = message.markdown;
    return base;
  }
  base.text = message.text;
  return base;
}

function createSlackApiOptions(botToken: SlackBotToken | undefined): SlackApiOptions {
  return { token: () => resolveSlackBotToken(botToken) };
}

function normalizeSlackApiBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function toSlackFileUpload(file: FileUpload): SlackFileUpload {
  return {
    data: normalizeFileData(file.data),
    filename: file.filename,
  };
}

function normalizeFileData(data: FileUpload["data"]): SlackFileUpload["data"] {
  if (data instanceof ArrayBuffer) return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return data;
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
