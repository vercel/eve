import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { FilePart, ModelMessage, TextPart, UserContent } from "ai";

import { buildAdapterContext } from "#channel/adapter-context.js";
import type { ChannelAdapterContext, FetchFileResult } from "#channel/adapter.js";
import { getAdapterKind } from "#channel/adapter.js";
import { buildSessionHandle } from "#channel/session.js";
import { loadContext } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { fileDataToBytes } from "#internal/attachments/data.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { createLogger } from "#internal/logging.js";
import { deserializeUrlFilePart, isSerializedUrlFilePart } from "#internal/attachments/url-refs.js";
import {
  decodeSandboxRef,
  encodeSandboxRef,
  isSandboxRefUrl,
  type SandboxRef,
} from "#internal/attachments/sandbox-refs.js";
import type { SandboxSession } from "#public/definitions/sandbox.js";
import { toErrorMessage } from "#shared/errors.js";

/**
 * Sandbox directory where inbound file attachments are staged before the
 * model call. Authored canonical path — {@link SandboxSession.writeFile}
 * translates to the backend-native location.
 */
export const ATTACHMENTS_ROOT = "/workspace/attachments";

const log = createLogger("harness.attachment-staging");

const UNSAFE_FILENAME_CHARS = /[^\w.-]+/g;
const SHA_PREFIX_LENGTH = 16;

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Upper bound, in bytes, on image payloads that hydrate as inline bytes
 * on the model call. Larger images are substituted for a text reference
 * pointing at the staged sandbox path so the agent can read the file
 * through its normal filesystem tools (`read_file`, `bash`, etc.).
 */
const HYDRATE_IMAGE_INLINE_MAX_BYTES = 3 * 1024 * 1024;

/**
 * Upper bound, in bytes, on PDF payloads that hydrate as inline bytes.
 * Matches provider-side caps for native document understanding.
 */
const HYDRATE_PDF_INLINE_MAX_BYTES = 20 * 1024 * 1024;

const PDF_MEDIA_TYPE = "application/pdf";
const IMAGE_MEDIA_TYPE_PREFIX = "image/";

/**
 * Writes inbound `FilePart` bytes into the sandbox and rewrites each
 * staged part to a compact `eve-sandbox:` ref.
 *
 * Remote HTTP URLs pass through for provider-side fetches; existing
 * `eve-sandbox:` refs pass through so staging is idempotent.
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

  return Promise.all(
    reconstituted.map(async (part) => {
      if (part.type === "file") {
        return stageFilePart(part, sandbox, adapterCtx);
      }
      return part;
    }),
  );
}

/**
 * Context-bound variant of {@link stageAttachmentsForAdapter}. Returns
 * the input unchanged when there is no active sandbox or no file parts.
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
  const sandboxAccess = container.get(SandboxKey);
  if (sandboxAccess === undefined) {
    return message;
  }

  const sandbox = await sandboxAccess.get();
  if (sandbox === null) {
    return message;
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
 * Hydrates `eve-sandbox:` file refs for a single model call.
 *
 * Small images and PDFs are inlined as bytes; larger or unsupported files
 * become text references to their sandbox path. The returned messages must
 * not be written back to session history, which stays ref-only across steps.
 */
export async function hydrateSandboxAttachments(
  messages: readonly ModelMessage[],
): Promise<ModelMessage[]> {
  if (!messagesContainSandboxRef(messages)) {
    return messages as ModelMessage[];
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
  }
  return false;
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
  return Promise.all(
    content.map(async (part) => {
      if (!isSandboxRefFilePart(part)) {
        return part;
      }
      const filePart = part;
      const ref = decodeSandboxRef(filePart.data as URL);
      if (!shouldInlineSandboxRefAsBytes(ref)) {
        return renderSandboxRefAsTextPart(ref);
      }
      const bytes = await sandbox.readBinaryFile({ path: ref.path });
      if (bytes === null) {
        // #325: sandbox snapshots can change during a session lifecycle
        // as they are deployment bounded.
        log.warn(
          "sandbox-ref attachment bytes missing on hydration — degrading to text reference",
          {
            mediaType: ref.mediaType,
            path: ref.path,
            size: ref.size,
          },
        );
        return {
          text: `FileNotFound: Current snapshot may be newer and does not contain ${ref.path}.`,
          type: "text",
        } satisfies TextPart;
      }
      return { ...filePart, data: bytes, mediaType: ref.mediaType };
    }),
  );
}

/**
 * Decides whether a sandbox-resident attachment should flow to the
 * model as inline bytes at the hydration step, or be substituted for a
 * text reference pointing at the staged sandbox path.
 *
 * Keep this decision narrow: only the shapes every major provider
 * supports natively qualify for byte inlining. Everything else — raw
 * documents, archives, source code, oversized images/PDFs — reaches
 * the model as a text reference so the agent's filesystem tools do
 * the reading.
 */
function shouldInlineSandboxRefAsBytes(ref: SandboxRef): boolean {
  if (ref.mediaType.startsWith(IMAGE_MEDIA_TYPE_PREFIX)) {
    return ref.size <= HYDRATE_IMAGE_INLINE_MAX_BYTES;
  }
  if (ref.mediaType === PDF_MEDIA_TYPE) {
    return ref.size <= HYDRATE_PDF_INLINE_MAX_BYTES;
  }
  return false;
}

/**
 * Renders a sandbox-resident attachment as a {@link TextPart} the model
 * can use to reach the payload through filesystem tools.
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
): Promise<FilePart> {
  if (isSandboxRefUrl(part.data)) {
    return part;
  }

  // URL objects (including reconstituted ones) → try fetchFile
  if (part.data instanceof URL && part.data.protocol !== "data:") {
    const resolved = await tryFetchFile(part.data.href, adapterCtx);
    if (resolved === null) {
      return part;
    }
    return stageResolvedBytes(part, resolved, sandbox);
  }

  // Inline data (Buffer, base64, data URL) → stage directly
  const bytes = await fileDataToBytes(part.data);
  if (bytes === null) {
    return part;
  }
  return stageResolvedBytes(part, { bytes }, sandbox);
}

async function stageResolvedBytes(
  part: FilePart,
  resolved: FetchFileResult,
  sandbox: SandboxSession,
): Promise<FilePart> {
  const bytes = resolved.bytes;
  const sha = sha256Prefix(bytes);
  const mediaType = resolved.mediaType ?? part.mediaType ?? DEFAULT_MEDIA_TYPE;
  const name = safeFilename(resolved.filename ?? part.filename, sha);
  const authored = `${ATTACHMENTS_ROOT}/${sha}/${name}`;

  await sandbox.writeBinaryFile({ content: bytes, path: authored });
  const resolvedPath = sandbox.resolvePath(authored);
  return {
    ...part,
    data: encodeSandboxRef({ mediaType, path: resolvedPath, size: bytes.byteLength }),
    filename: resolvedPath,
    mediaType,
  };
}

async function tryFetchFile(
  url: string,
  adapterCtx: ChannelAdapterContext,
): Promise<FetchFileResult | null> {
  const adapter = adapterCtx.ctx.get(ChannelKey);
  if (adapter?.fetchFile === undefined) {
    return null;
  }

  const adapterKind = getAdapterKind(adapter);

  try {
    const result = await adapter.fetchFile(url);
    if (result === null) {
      return null;
    }
    return Buffer.isBuffer(result) ? { bytes: result } : result;
  } catch (cause) {
    if (cause instanceof EveAttachmentError) {
      throw cause;
    }
    throw new EveAttachmentError({
      adapterKind,
      cause,
      kind: "resolver-threw",
      message: `fetchFile for adapter kind="${adapterKind}" threw: ${toErrorMessage(cause)}`,
    });
  }
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

function sha256Prefix(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, SHA_PREFIX_LENGTH);
}

function safeFilename(provided: string | undefined, sha: string): string {
  if (provided === undefined) {
    return `file-${sha}`;
  }
  const base = basename(provided).replace(UNSAFE_FILENAME_CHARS, "_");
  return base.length > 0 ? base : `file-${sha}`;
}
