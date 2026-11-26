import { createHash } from "node:crypto";
import { basename, dirname, extname } from "node:path";
import type { FilePart, ModelMessage, TextPart, ToolResultPart, UserContent } from "ai";

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapterContext, FetchFileResult } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import { buildChannelContext } from "#channel/session.js";
import { contextStorage, loadContext } from "#context/container.js";
import { SandboxKey, SessionIdKey } from "#context/keys.js";
import { createFrameworkUserMessage, type HarnessModelMessage } from "#harness/messages.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { isUnresolvedFileData, readFileData } from "#internal/attachments/data.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { createLogger } from "#internal/logging.js";
import { maxBytesOf } from "#internal/attachments/limited-read.js";
import { verifyMediaType } from "#internal/attachments/media-metadata.js";
import { readMediaMetadata } from "#internal/attachments/read-media-metadata.js";
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
import type { SandboxAccess } from "#sandbox/state.js";

const ATTACHMENTS_ROOT = ".eve/attachments";

const log = createLogger("harness.attachment-staging");

const UNSAFE_FILENAME_CHARS = /[^\w.-]+/g;
const SHA_PREFIX_LENGTH = 16;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

const CACHED_REF_BYTES_LIMIT = 64 * 1024 * 1024;

const cachedRefBytes = new Map<string, Buffer>();
let cachedRefBytesTotal = 0;

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

export async function stageAttachmentsForAdapter(
  content: string | UserContent,
  sandbox: SandboxSession,
  adapterCtx: ChannelAdapterContext,
): Promise<string | UserContent> {
  if (typeof content === "string") {
    return content;
  }

  const policy = adapterCtx.ctx.get(ChannelKey)?.uploadPolicy;
  const downloads = createPublicDownloads(maxBytesOf(policy ?? DEFAULT_UPLOAD_POLICY));
  return stageContentWithDownloads(content, sandbox, adapterCtx, downloads, policy);
}

export async function stageAttachmentsToSandbox(
  message: string | UserContent,
): Promise<string | UserContent> {
  return (await stageUserContentBatch([message]))[0]!;
}

export async function stageHistoryAttachments(
  messages: readonly HarnessModelMessage[],
): Promise<HarnessModelMessage[]> {
  const fileMessageIndexes: number[] = [];
  const contents: UserContent[] = [];
  for (const [index, message] of messages.entries()) {
    if (
      message.role === "user" &&
      Array.isArray(message.content) &&
      hasFileParts(message.content)
    ) {
      fileMessageIndexes.push(index);
      contents.push(message.content);
    }
  }
  if (fileMessageIndexes.length === 0) return [...messages];
  const staged = await stageUserContentBatch(contents);
  const result = [...messages];
  for (const [offset, messageIndex] of fileMessageIndexes.entries()) {
    const original = messages[messageIndex]!;
    if (original.role === "user") {
      result[messageIndex] = { ...original, content: staged[offset]! };
    }
  }
  return result;
}

async function stageUserContentBatch(
  contents: readonly (string | UserContent)[],
): Promise<(string | UserContent)[]> {
  if (!contents.some((content) => Array.isArray(content) && hasFileParts(content))) {
    return [...contents];
  }

  const container = loadContext();
  const sandbox = await activeSandbox(container.get(SandboxKey));
  if (sandbox === null) {
    return contents.map((content) =>
      !Array.isArray(content)
        ? content
        : content.map((part) =>
            part.type === "file" &&
            !isSandboxRefUrl(part.data) &&
            readFileData(part.data).kind !== "reference"
              ? attachmentNote(part, "could not be stored: no sandbox is available.")
              : part,
          ),
    );
  }

  const adapter = container.get(ChannelKey);
  const adapterCtx: ChannelAdapterContext = adapter
    ? buildAdapterContext(adapter, container)
    : {
        ctx: container,
        state: {},
        session: buildChannelContext(container).session,
      };
  const policy = adapterCtx.ctx.get(ChannelKey)?.uploadPolicy;
  const downloads = createPublicDownloads(maxBytesOf(policy ?? DEFAULT_UPLOAD_POLICY));

  return Promise.all(
    contents.map((content) =>
      Array.isArray(content)
        ? stageContentWithDownloads(content, sandbox, adapterCtx, downloads, policy)
        : content,
    ),
  );
}

function stageContentWithDownloads(
  content: Exclude<UserContent, string>,
  sandbox: SandboxSession,
  adapterCtx: ChannelAdapterContext,
  downloads: PublicDownloads,
  policy: UploadPolicy | undefined,
): Promise<UserContent> {
  const reconstituted = reconstitueFilePartUrls(content);
  return Promise.all(
    reconstituted.map(async (part) =>
      part.type === "file" ? stageFilePart(part, sandbox, adapterCtx, downloads, policy) : part,
    ),
  );
}

export async function stageToolResultMedia<T extends ModelMessage>(
  messages: readonly T[],
): Promise<T[]> {
  if (!messages.some(hasInlineToolResultFile)) {
    return [...messages];
  }
  const sandbox = await activeSandbox(contextStorage.getStore()?.get(SandboxKey));
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

export async function hydrateSandboxAttachments(
  input: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  const messages = replaceUnresolvedFileParts(input);
  if (!messagesContainSandboxRef(messages)) {
    return messages;
  }

  const context = loadContext();
  const read = sandboxRefReader(context.get(SandboxKey), context.get(SessionIdKey));
  return Promise.all(
    messages.map(async (message) => {
      if (!messageContainsSandboxRef(message)) {
        return message;
      }
      const content = await hydrateMessageContent(message.content, read);
      return { ...message, content } as ModelMessage;
    }),
  );
}

type SandboxRefReader = (ref: SandboxRef) => Promise<Uint8Array | null>;

function sandboxRefReader(
  access: SandboxAccess | undefined,
  sessionId: string | undefined,
): SandboxRefReader {
  let sandbox: Promise<SandboxSession | null> | undefined;
  return async (ref) => {
    const key = cacheKey(sessionId, ref);
    const cached = key === undefined ? undefined : readCachedRefBytes(key);
    if (cached !== undefined) return cached;
    if (access === undefined) {
      throw new Error(
        `Cannot hydrate attachment ${ref.path}: no SandboxKey is bound on the active eve context. ` +
          "Hydration must run inside a step scope with the framework sandbox provider installed.",
      );
    }
    sandbox ??= activeSandbox(access);
    const bytes = await readSandboxRefBytes(ref, await sandbox);
    if (bytes !== null && key !== undefined) cacheRefBytes(key, bytes);
    return bytes;
  };
}

function cacheKey(sessionId: string | undefined, ref: SandboxRef): string | undefined {
  if (sessionId === undefined) return undefined;
  return JSON.stringify([sessionId, ref.path, ref.size, ref.mediaType]);
}

function readCachedRefBytes(key: string): Buffer | undefined {
  const bytes = cachedRefBytes.get(key);
  if (bytes !== undefined) {
    cachedRefBytes.delete(key);
    cachedRefBytes.set(key, bytes);
  }
  return bytes;
}

function cacheRefBytes(key: string, bytes: Uint8Array): void {
  if (bytes.byteLength > CACHED_REF_BYTES_LIMIT || cachedRefBytes.has(key)) return;
  cachedRefBytes.set(key, Buffer.from(bytes));
  cachedRefBytesTotal += bytes.byteLength;
  for (const [oldestKey, oldest] of cachedRefBytes) {
    if (cachedRefBytesTotal <= CACHED_REF_BYTES_LIMIT) break;
    cachedRefBytes.delete(oldestKey);
    cachedRefBytesTotal -= oldest.byteLength;
  }
}

async function activeSandbox(access: SandboxAccess | undefined): Promise<SandboxSession | null> {
  if (access === undefined) return null;
  try {
    return await access.open();
  } catch (error) {
    log.warn("session sandbox unavailable, degrading attachments to text", { error });
    return null;
  }
}

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
      if (sandbox === null || data.kind !== "bytes") return unstoredFileNote(part);
      try {
        const ref = await writeSandboxRef(data.bytes, part.mediaType, part.filename, sandbox);
        return {
          ...part,
          data: { type: "url" as const, url: encodeSandboxRef(ref) },
          mediaType: ref.mediaType,
        };
      } catch (error) {
        log.warn("sandbox write failed for a tool-result file, degrading it to text", { error });
        return unstoredFileNote(part);
      }
    }),
  );
  return { ...output, value };
}

function unstoredFileNote(part: ToolOutputFilePart): ToolOutputContentPart {
  return {
    text: `Returned file ${part.filename ?? "file"} (${part.mediaType}) could not be stored.`,
    type: "text",
  };
}

function isSandboxRefFilePart(part: unknown): part is FilePart {
  return (
    part !== null &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "file" &&
    isSandboxRefUrl((part as FilePart).data)
  );
}

async function hydrateMessageContent(content: unknown, read: SandboxRefReader): Promise<unknown> {
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
        const bytes = await read(ref);
        return bytes === null
          ? [renderMissingSandboxRef(ref)]
          : [label, { ...part, data: bytes, mediaType: ref.mediaType }];
      }
      if ((part as { type?: unknown }).type === "tool-result") {
        const toolResult = part as ToolResultPart;
        return [{ ...toolResult, output: await hydrateToolOutput(toolResult.output, read) }];
      }
      return [part];
    }),
  );
  return hydrated.flat();
}

async function hydrateToolOutput(
  output: ToolResultOutput,
  read: SandboxRefReader,
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
      const bytes = await read(ref);
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
  sandbox: SandboxSession | null,
): Promise<Uint8Array | null> {
  if (sandbox === null) return null;
  const bytes = await sandbox.readBinaryFile({ path: ref.path });
  if (bytes === null) {
    log.warn("sandbox-ref attachment bytes missing on hydration — degrading to text reference", {
      mediaType: ref.mediaType,
      path: ref.path,
      size: ref.size,
    });
    return null;
  }
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

function attachmentNote(part: FilePart, outcome: string): TextPart {
  return { text: `Attachment ${part.filename?.trim() || "file"} ${outcome}`, type: "text" };
}

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
  const ref = { ...readMediaMetadata(bytes, mediaType), path: sandbox.resolvePath(authored) };
  const key = cacheKey(contextStorage.getStore()?.get(SessionIdKey), ref);
  if (key !== undefined && inlinesSandboxRefAsBytes(ref)) cacheRefBytes(key, bytes);
  return ref;
}

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
