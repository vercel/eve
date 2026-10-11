import { createHash } from "node:crypto";
import { basename, dirname, extname } from "node:path";
import type { FilePart, ModelMessage, TextPart, ToolResultPart, UserContent } from "ai";

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapterContext, FetchFileResult } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import { buildSessionHandle } from "#channel/session.js";
import { contextStorage, loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { createFrameworkUserMessage } from "#harness/messages.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { isUnresolvedFileData, readFileData } from "#internal/attachments/data.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { createLogger } from "#internal/logging.js";
import { maxBytesOf } from "#internal/attachments/limited-read.js";
import { readMediaMetadata, verifyMediaType } from "#internal/attachments/media-metadata.js";
import {
  DEFAULT_UPLOAD_POLICY,
  isMediaTypeAllowed,
  type UploadPolicy,
} from "#public/channels/upload-policy.js";
import { createPublicDownloads, type PublicDownloads } from "#internal/attachments/public-link.js";
import { deserializeUrlFilePart, isSerializedUrlFilePart } from "#internal/attachments/url-refs.js";
import {
  decodeSandboxRef,
  encodeSandboxRef,
  inlinesSandboxRefAsBytes,
  isSandboxRefUrl,
  type SandboxRef,
} from "#internal/attachments/sandbox-refs.js";
import type { SandboxSession } from "#public/definitions/sandbox.js";

/**
 * Sandbox directory where eve stages message attachments and tool-result
 * files. It sits under eve's own dot-directory so it never collides with an
 * agent's `/workspace/attachments`. Authored canonical path —
 * {@link SandboxSession.writeFile} translates to the backend-native location.
 */
export const ATTACHMENTS_ROOT = "/workspace/.eve/attachments";

const log = createLogger("harness.attachment-staging");

const UNSAFE_FILENAME_CHARS = /[^\w.-]+/g;
const SHA_PREFIX_LENGTH = 16;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

// A staged name keeps or gains the extension its media type implies, so a
// nameless file (an MCP image, say) can still be opened by path later.
const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

type ToolResultOutput = ToolResultPart["output"];
type ToolOutputContentPart = Extract<ToolResultOutput, { type: "content" }>["value"][number];
type ToolOutputFilePart = Extract<ToolOutputContentPart, { type: "file" }>;

/**
 * Writes inbound `FilePart` bytes into the sandbox and rewrites each
 * staged part to a compact `eve-sandbox:` ref. Links resolve through the
 * channel's `fetchFile` or eve's public download; a file eve can't stage
 * becomes a note. Existing `eve-sandbox:` refs pass through so staging is
 * idempotent.
 */
export async function stageAttachmentsForAdapter(
  content: string | UserContent,
  sandbox: SandboxSession,
  adapterCtx: ChannelAdapterContext,
): Promise<string | UserContent> {
  if (typeof content === "string") {
    return content;
  }

  const reconstituted = reconstitueFilePartUrls(content);
  const policy = adapterCtx.ctx.get(ChannelKey)?.uploadPolicy;
  const downloads = createPublicDownloads(maxBytesOf(policy ?? DEFAULT_UPLOAD_POLICY));

  return Promise.all(
    reconstituted.map(async (part) => {
      if (part.type === "file") {
        return stageFilePart(part, sandbox, adapterCtx, downloads, policy);
      }
      return part;
    }),
  );
}

/**
 * Context-bound variant of {@link stageAttachmentsForAdapter}. Without an
 * active sandbox, every file part becomes a note: history never keeps an
 * attachment eve did not stage.
 */
export async function stageAttachmentsToSandbox(
  message: string | UserContent,
): Promise<string | UserContent> {
  if (typeof message === "string") {
    return message;
  }
  if (!Array.isArray(message)) {
    return message;
  }
  if (!hasFileParts(message)) {
    return message;
  }

  const container = loadContext();
  const sandbox = (await container.get(SandboxKey)?.get()) ?? null;
  if (sandbox === null) {
    return message.map((part) =>
      part.type === "file" &&
      !isSandboxRefUrl(part.data) &&
      readFileData(part.data).kind !== "reference"
        ? attachmentNote(part, "could not be stored: no sandbox is available.")
        : part,
    );
  }

  // Build the adapter context once up front. When an adapter is bound,
  // use the same helper the runtime uses for `deliver` and event
  // handlers so the Slack (and other) `createAdapterContext` override
  // runs. When no adapter is bound, build a minimal accessor-only ctx
  // so inline FileParts still stage cleanly — a ref on the message will
  // raise `missing-adapter` inside the resolver dispatch.
  const adapter = container.get(ChannelKey);
  const adapterCtx: ChannelAdapterContext = adapter
    ? buildAdapterContext(adapter, container)
    : {
        ctx: container,
        state: {},
        session: buildSessionHandle(container),
      };

  return stageAttachmentsForAdapter(message, sandbox, adapterCtx);
}

/**
 * Moves inline file payloads in `content` tool outputs into the sandbox and
 * leaves `eve-sandbox:` refs in their place, so durable history never
 * carries tool-result bytes. {@link hydrateSandboxAttachments} restores the
 * bytes on every model call. Without an active sandbox, each file becomes a
 * note instead.
 */
export async function stageToolResultMedia<T extends ModelMessage>(
  messages: readonly T[],
): Promise<T[]> {
  if (!messages.some(hasInlineToolResultFile)) {
    return [...messages];
  }
  const sandbox = (await contextStorage.getStore()?.get(SandboxKey)?.get()) ?? null;
  return Promise.all(
    messages.map(async (message) => {
      if (message.role !== "tool" || !hasInlineToolResultFile(message)) {
        return message;
      }
      const content = await Promise.all(
        message.content.map(async (part) =>
          part.type === "tool-result"
            ? { ...part, output: await stageToolOutputFiles(part.output, sandbox) }
            : part,
        ),
      );
      return { ...message, content };
    }),
  );
}

/**
 * Hydrates `eve-sandbox:` file refs for a single model call.
 *
 * Every attachment, inbound or returned by a tool, renders as a label naming
 * its sandbox path. Small verified images and PDFs follow their label as
 * bytes; anything else stays a label the agent can open with tools. Every
 * decision is pure in the ref, so each message renders identically on every
 * call and the provider's prompt cache stays valid. The returned messages
 * must not be written back to session history, which stays ref-only.
 */
export async function hydrateSandboxAttachments(
  input: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  const messages = replaceUnresolvedFileParts(input);
  if (!messagesContainSandboxRef(messages)) {
    return messages;
  }

  const sandboxAccess = loadContext().get(SandboxKey);
  if (sandboxAccess === undefined) {
    throw new Error(
      "Cannot hydrate sandbox-ref FilePart: no SandboxKey is bound on the active eve context. " +
        "Hydration must run inside a step scope with the framework sandbox provider installed.",
    );
  }

  const sandbox = await sandboxAccess.get();
  if (sandbox === null) {
    throw new Error(
      "Cannot hydrate sandbox-ref FilePart: SandboxKey is bound but no active sandbox session is available.",
    );
  }

  return Promise.all(
    messages.map(async (message) => {
      if (!messageContainsSandboxRef(message)) {
        return message;
      }
      const content = await hydrateMessageContent(message.content, sandbox);
      return { ...message, content } as ModelMessage;
    }),
  );
}

/**
 * History written before eve resolved every attachment can still hold a link
 * or an `eve-url:` marker that a provider would try to fetch on every call.
 * Each renders as a note, so such a session recovers.
 */
function replaceUnresolvedFileParts(messages: readonly ModelMessage[]): ModelMessage[] {
  let changed = false;
  const result = messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) return message;
    if (!message.content.some(isUnresolvedFilePart)) return message;
    changed = true;
    const content = message.content.map((part) =>
      isUnresolvedFilePart(part) ? attachmentNote(part, "could not be retrieved.") : part,
    );
    return { ...message, content };
  });
  return changed ? result : (messages as ModelMessage[]);
}

function isUnresolvedFilePart(part: Exclude<UserContent, string>[number]): part is FilePart {
  return part.type === "file" && !isSandboxRefUrl(part.data) && isUnresolvedFileData(part.data);
}

function hasFileParts(content: Exclude<UserContent, string>): boolean {
  for (const part of content) {
    if (part.type === "file") {
      return true;
    }
  }
  return false;
}

function messagesContainSandboxRef(messages: readonly ModelMessage[]): boolean {
  for (const message of messages) {
    if (messageContainsSandboxRef(message)) {
      return true;
    }
  }
  return false;
}

function messageContainsSandboxRef(message: ModelMessage): boolean {
  const content = message.content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (isSandboxRefFilePart(part)) {
      return true;
    }
    if (part.type === "tool-result" && contentOutputParts(part.output).some(isToolOutputRefFile)) {
      return true;
    }
  }
  return false;
}

function contentOutputParts(output: ToolResultOutput): readonly ToolOutputContentPart[] {
  return output.type === "content" ? output.value : [];
}

function hasInlineToolResultFile(message: ModelMessage): boolean {
  return (
    message.role === "tool" &&
    message.content.some(
      (part) =>
        part.type === "tool-result" && contentOutputParts(part.output).some(isInlineToolOutputFile),
    )
  );
}

function isInlineToolOutputFile(part: ToolOutputContentPart): part is ToolOutputFilePart {
  return part.type === "file" && part.data.type === "data";
}

function isToolOutputRefFile(part: ToolOutputContentPart): part is ToolOutputFilePart {
  return part.type === "file" && part.data.type === "url" && isSandboxRefUrl(part.data.url);
}

async function stageToolOutputFiles(
  output: ToolResultOutput,
  sandbox: SandboxSession | null,
): Promise<ToolResultOutput> {
  if (output.type !== "content" || !output.value.some(isInlineToolOutputFile)) {
    return output;
  }
  const value = await Promise.all(
    output.value.map(async (part): Promise<ToolOutputContentPart> => {
      if (!isInlineToolOutputFile(part) || part.data.type !== "data") return part;
      const data = readFileData(part.data.data);
      if (data.kind === "link") return part;
      if (sandbox === null || data.kind !== "bytes") {
        return {
          text: `Returned file ${part.filename ?? "file"} (${part.mediaType}) could not be stored.`,
          type: "text",
        };
      }
      const ref = await writeSandboxRef(data.bytes, part.mediaType, part.filename, sandbox);
      return {
        ...part,
        data: { type: "url" as const, url: encodeSandboxRef(ref) },
        mediaType: ref.mediaType,
      };
    }),
  );
  return { ...output, value };
}

/**
 * Narrows a `UserContent` / `ModelMessage.content` element to a
 * {@link FilePart} whose `data` is an `eve-sandbox:` ref URL.
 *
 * Safe on arbitrary input shapes — returns `false` for strings,
 * `null`, non-object values, non-file parts, and file parts whose
 * `data` is not a sandbox ref. Centralises the structural check used
 * by the staging and hydration passes so the two stay in lockstep.
 */
function isSandboxRefFilePart(part: unknown): part is FilePart {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "file" &&
    isSandboxRefUrl((part as FilePart).data)
  );
}

async function hydrateMessageContent(content: unknown, sandbox: SandboxSession): Promise<unknown> {
  if (!Array.isArray(content)) {
    return content;
  }
  const hydrated = await Promise.all(
    content.map(async (part): Promise<unknown[]> => {
      if (isSandboxRefFilePart(part)) {
        const ref = decodeSandboxRef(part.data as URL);
        const label = renderSandboxRefAsTextPart(ref);
        if (!inlinesSandboxRefAsBytes(ref)) {
          return [label];
        }
        const bytes = await readSandboxRefBytes(ref, sandbox);
        return bytes === null
          ? [renderMissingSandboxRef(ref)]
          : [label, { ...part, data: bytes, mediaType: ref.mediaType }];
      }
      if ((part as { type?: unknown }).type === "tool-result") {
        const toolResult = part as ToolResultPart;
        return [{ ...toolResult, output: await hydrateToolOutput(toolResult.output, sandbox) }];
      }
      return [part];
    }),
  );
  return hydrated.flat();
}

async function hydrateToolOutput(
  output: ToolResultOutput,
  sandbox: SandboxSession,
): Promise<ToolResultOutput> {
  if (output.type !== "content" || !output.value.some(isToolOutputRefFile)) {
    return output;
  }
  const value = await Promise.all(
    output.value.map(async (part): Promise<ToolOutputContentPart[]> => {
      if (!isToolOutputRefFile(part) || part.data.type !== "url") return [part];
      const ref = decodeSandboxRef(part.data.url);
      const label = renderSandboxRefAsTextPart(ref);
      if (!inlinesSandboxRefAsBytes(ref)) return [label];
      const bytes = await readSandboxRefBytes(ref, sandbox);
      if (bytes === null) return [renderMissingSandboxRef(ref)];
      return [
        label,
        { ...part, data: { data: Buffer.from(bytes).toString("base64"), type: "data" } },
      ];
    }),
  );
  return { ...output, value: value.flat() };
}

async function readSandboxRefBytes(
  ref: SandboxRef,
  sandbox: SandboxSession,
): Promise<Uint8Array | null> {
  const bytes = await sandbox.readBinaryFile({ path: ref.path });
  if (bytes === null) {
    // #325: sandbox snapshots can change during a session lifecycle
    // as they are deployment bounded.
    log.warn("sandbox-ref attachment bytes missing on hydration — degrading to text reference", {
      mediaType: ref.mediaType,
      path: ref.path,
      size: ref.size,
    });
    return null;
  }
  // Sandbox code can overwrite a staged file; only the bytes eve staged may
  // reach the model as the original attachment.
  if (bytes.byteLength !== ref.size || sha256Prefix(bytes) !== basename(dirname(ref.path))) {
    log.warn("sandbox-ref attachment bytes changed since staging — degrading to text reference", {
      mediaType: ref.mediaType,
      path: ref.path,
      size: ref.size,
    });
    return null;
  }
  return bytes;
}

function renderMissingSandboxRef(ref: SandboxRef): TextPart {
  return {
    text: `FileNotFound: Current snapshot may be newer and does not contain ${ref.path}.`,
    type: "text",
  };
}

/**
 * Chat Completions-style providers (`*.chat`) serialize `content` tool
 * outputs as JSON text, so a file would reach the model as base64
 * characters. Moves the files of each run of tool messages into one user
 * message right after it, leaving a text stub in the tool result. The move
 * is deterministic, so the prompt prefix stays cache-stable.
 */
export function moveToolResultFilesToUserMessages(
  messages: readonly ModelMessage[],
): ModelMessage[] {
  const moved: ModelMessage[] = [];
  let files: FilePart[] = [];
  for (const message of messages) {
    if (message.role !== "tool" && files.length > 0) {
      moved.push(createReturnedFilesMessage(files));
      files = [];
    }
    if (message.role !== "tool") {
      moved.push(message);
      continue;
    }
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || part.output.type !== "content") return part;
      const value = part.output.value.map((entry): ToolOutputContentPart => {
        if (entry.type !== "file") return entry;
        const file = { data: entry.data, mediaType: entry.mediaType, type: "file" } as FilePart;
        if (entry.filename !== undefined) file.filename = entry.filename;
        files.push(file);
        return {
          text: `Attached file ${entry.filename ?? "file"} (${entry.mediaType}) follows this tool result.`,
          type: "text",
        };
      });
      return { ...part, output: { ...part.output, value } };
    });
    moved.push({ ...message, content });
  }
  if (files.length > 0) moved.push(createReturnedFilesMessage(files));
  return moved;
}

function createReturnedFilesMessage(files: readonly FilePart[]): ModelMessage {
  return createFrameworkUserMessage("context.state", [
    { text: "Files returned by the preceding tool results:", type: "text" },
    ...files,
  ]);
}

/**
 * Labels a sandbox-resident attachment with a {@link TextPart} the model can
 * use to reach the payload through filesystem tools, whether or not the
 * bytes follow.
 *
 * Matches the text shape produced by the compaction summarizer for
 * `FilePart`s so the model sees one consistent surface for "there is a
 * file at this path" regardless of whether the reference came from the
 * current turn's hydration or a summarized older turn.
 */
function renderSandboxRefAsTextPart(ref: SandboxRef): TextPart {
  return { text: `Attached file ${ref.path} (${ref.mediaType})`, type: "text" };
}

async function stageFilePart(
  part: FilePart,
  sandbox: SandboxSession,
  adapterCtx: ChannelAdapterContext,
  downloads: PublicDownloads,
  policy: UploadPolicy | undefined,
): Promise<FilePart | TextPart> {
  if (isSandboxRefUrl(part.data)) {
    return part;
  }

  const data = readFileData(part.data);
  if (data.kind === "bytes") {
    return stageResolvedBytes(part, { bytes: data.bytes }, sandbox, policy);
  }
  // The provider already holds a referenced file.
  if (data.kind === "reference") {
    return part;
  }
  if (data.kind === "unreadable") {
    log.warn("attachment data is not bytes, base64, or a URL — degrading to text part", {
      filename: part.filename,
      mediaType: part.mediaType,
    });
    return attachmentNote(part, "could not be read.");
  }

  let resolved: FetchFileResult;
  try {
    resolved = await resolveLink(data.url, adapterCtx, downloads);
  } catch (error) {
    if (!(error instanceof EveAttachmentError)) throw error;
    log.warn("attachment resolver failed — degrading to text part", {
      adapterKind: error.adapterKind,
      error: error.cause,
      filename: part.filename,
      kind: error.kind,
    });
    return attachmentNote(part, `could not be retrieved: ${error.message}`);
  }
  return stageResolvedBytes(part, resolved, sandbox, policy);
}

/** A model-visible note that stands in for an attachment eve could not stage. */
function attachmentNote(part: FilePart, outcome: string): TextPart {
  return { text: `Attachment ${part.filename?.trim() || "file"} ${outcome}`, type: "text" };
}

/**
 * Stages resolved bytes, or a note when they break the channel's upload
 * policy. A link's size is unknown until it downloads, and only the bytes
 * prove the media type, so the policy runs here as well as at the route.
 */
async function stageResolvedBytes(
  part: FilePart,
  resolved: FetchFileResult,
  sandbox: SandboxSession,
  policy: UploadPolicy | undefined,
): Promise<FilePart | TextPart> {
  const mediaType = verifyMediaType(
    resolved.bytes,
    resolved.mediaType ?? part.mediaType ?? DEFAULT_MEDIA_TYPE,
  );
  if (policy !== undefined) {
    const limit = maxBytesOf(policy);
    if (resolved.bytes.byteLength > limit) {
      return attachmentNote(
        part,
        `was not accepted: it is ${resolved.bytes.byteLength} bytes, over this channel's ${limit}-byte upload limit.`,
      );
    }
    if (!isMediaTypeAllowed(mediaType, policy)) {
      return attachmentNote(
        part,
        `was not accepted: this channel doesn't accept ${mediaType} files.`,
      );
    }
  }
  const ref = await writeSandboxRef(
    resolved.bytes,
    mediaType,
    resolved.filename ?? part.filename,
    sandbox,
  );
  return { ...part, data: encodeSandboxRef(ref), filename: ref.path, mediaType: ref.mediaType };
}

/**
 * Writes content-addressed bytes under {@link ATTACHMENTS_ROOT} and describes
 * them as a ref whose media type the bytes confirm.
 */
async function writeSandboxRef(
  bytes: Buffer,
  declaredMediaType: string,
  filename: string | undefined,
  sandbox: SandboxSession,
): Promise<SandboxRef> {
  const mediaType = verifyMediaType(bytes, declaredMediaType);
  const sha = sha256Prefix(bytes);
  const authored = `${ATTACHMENTS_ROOT}/${sha}/${safeFilename(filename, sha, mediaType)}`;
  await sandbox.writeBinaryFile({ content: bytes, path: authored });
  return { ...readMediaMetadata(bytes, mediaType), path: sandbox.resolvePath(authored) };
}

/**
 * Resolves a link through the channel's `fetchFile`. When the channel has none
 * or returns `null`, eve downloads a public `https:` link itself; a provider
 * never fetches an attachment.
 */
async function resolveLink(
  url: URL,
  adapterCtx: ChannelAdapterContext,
  downloads: PublicDownloads,
): Promise<FetchFileResult> {
  const adapter = adapterCtx.ctx.get(ChannelKey);
  const adapterKind = adapter === undefined ? "none" : getAdapterKind(adapter);

  if (adapter?.fetchFile !== undefined) {
    let result: Awaited<ReturnType<NonNullable<typeof adapter.fetchFile>>>;
    try {
      result = await adapter.fetchFile(url.href, adapterCtx);
    } catch (cause) {
      if (cause instanceof EveAttachmentError) {
        // Operator logs name the channel that ran the resolver, not one it claims.
        throw new EveAttachmentError({
          adapterKind,
          cause: cause.cause,
          kind: cause.kind,
          message: cause.message,
        });
      }
      throw new EveAttachmentError({
        adapterKind,
        cause,
        kind: "resolver-threw",
        message: `Attachment retrieval failed in the "${adapterKind}" channel.`,
      });
    }
    if (result !== null) {
      return Buffer.isBuffer(result) ? { bytes: result } : result;
    }
  }
  return downloads(url, adapterKind);
}

/**
 * Reconstitutes `URL` objects from `eve-url:` serialized strings in
 * `FilePart.data`. Before the queue boundary, `send()` serializes
 * `URL` objects as `eve-url:{href}` strings. This pass restores them
 * so the staging pipeline can use `instanceof URL`.
 */
function reconstitueFilePartUrls(
  content: Exclude<UserContent, string>,
): Exclude<UserContent, string> {
  let changed = false;
  const result = content.map((part) => {
    if (part.type === "file" && isSerializedUrlFilePart(part.data)) {
      changed = true;
      return { ...part, data: deserializeUrlFilePart(part.data) };
    }
    return part;
  });
  return changed ? result : content;
}

function sha256Prefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, SHA_PREFIX_LENGTH);
}

function safeFilename(provided: string | undefined, sha: string, mediaType: string): string {
  const base = provided === undefined ? "" : basename(provided).replace(UNSAFE_FILENAME_CHARS, "_");
  const name = base.length > 0 ? base : `file-${sha}`;
  const extension = MEDIA_TYPE_EXTENSIONS[mediaType];
  return extension === undefined || extname(name) !== "" ? name : `${name}${extension}`;
}
