import type { FilePart, TextPart, UserContent } from "ai";

import type { FetchFileResult } from "#channel/adapter.js";
import { createLogger } from "#internal/logging.js";
import {
  downloadTelegramFile,
  getTelegramFile,
  type TelegramApiOptions,
} from "#public/channels/telegram/api.js";
import type { TelegramAttachment, TelegramMessage } from "#public/channels/telegram/inbound.js";
import {
  evaluateFilePart,
  formatUploadPolicyViolation,
  isMediaTypeAllowed,
  isUploadsDisabled,
  type UploadPolicy,
} from "#public/channels/upload-policy.js";

const log = createLogger("telegram.attachments");

/** URL protocol used by the channel to defer Telegram file downloads to `fetchFile`. */
export const TELEGRAM_FILE_URL_PROTOCOL = "telegram-file:";

/** Emits one {@link FilePart} per supported Telegram attachment. */
export function collectTelegramFileParts(
  attachments: readonly TelegramAttachment[],
  policy: UploadPolicy,
): FilePart[] {
  if (isUploadsDisabled(policy)) return [];

  const parts: FilePart[] = [];
  for (const attachment of attachments) {
    const part = toTelegramFilePart(attachment, parts.length);
    if (part === null) continue;

    const violation = evaluateTelegramFilePart(part, attachment.size, policy);
    if (violation !== null) {
      log.warn(`dropped attachment — ${formatUploadPolicyViolation(violation)}`, {
        fileId: attachment.fileId,
        name: attachment.fileName,
      });
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/** Combines text/caption + file parts into the {@link UserContent} shape the harness expects. */
export function buildTelegramTurnMessage(
  message: Pick<TelegramMessage, "caption" | "text">,
  fileParts: readonly FilePart[],
): string | UserContent {
  const text = message.text || message.caption;
  if (fileParts.length === 0) return text;
  if (text.trim().length === 0) return [...fileParts];
  const textPart: TextPart = { type: "text", text };
  return [textPart, ...fileParts];
}

/**
 * Creates a `fetchFile` function for `telegram-file:` URLs. The returned
 * function resolves to `null` for unrecognized URLs and throws on HTTP errors
 * or upload-policy violations.
 */
export function createTelegramFetchFile(input: {
  readonly api?: Omit<TelegramApiOptions, "credentials">;
  readonly credentials?: TelegramApiOptions["credentials"];
  readonly policy: UploadPolicy;
}): (url: string) => Promise<FetchFileResult | null> {
  return async (url) => {
    const ref = parseTelegramFileUrl(url);
    if (ref === null) return null;

    const file = await getTelegramFile({
      apiBaseUrl: input.api?.apiBaseUrl,
      credentials: input.credentials,
      fetch: input.api?.fetch,
      fileId: ref.fileId,
    });
    const response = await downloadTelegramFile({
      apiBaseUrl: input.api?.apiBaseUrl,
      credentials: input.credentials,
      fetch: input.api?.fetch,
      fileBaseUrl: input.api?.fileBaseUrl,
      filePath: file.filePath,
    });
    if (!response.ok) {
      throw new Error(`Telegram file fetch returned HTTP ${response.status} for ${url}.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const mediaType =
      response.headers.get("content-type") ?? ref.mediaType ?? "application/octet-stream";
    const result: FetchFileResult = {
      bytes,
      filename: ref.filename,
      mediaType,
    };

    const violation = evaluateFilePart(
      {
        data: result.bytes,
        filename: result.filename,
        mediaType,
        type: "file",
      },
      input.policy,
    );
    if (violation !== null) {
      throw new Error(`Telegram file rejected — ${formatUploadPolicyViolation(violation)}`);
    }
    return result;
  };
}

/**
 * Builds a `telegram-file:` URL (fileId in the path, optional `filename` and
 * `mediaType` query params) that defers the download to the channel's
 * `fetchFile`. {@link createTelegramFetchFile} parses it back.
 */
export function createTelegramFileUrl(input: {
  readonly fileId: string;
  readonly filename?: string;
  readonly mediaType?: string;
}): URL {
  const params = new URLSearchParams();
  if (input.filename !== undefined) params.set("filename", input.filename);
  if (input.mediaType !== undefined) params.set("mediaType", input.mediaType);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return new URL(`${TELEGRAM_FILE_URL_PROTOCOL}${encodeURIComponent(input.fileId)}${suffix}`);
}

function toTelegramFilePart(attachment: TelegramAttachment, index: number): FilePart | null {
  const mediaType =
    attachment.mediaType ??
    (attachment.kind === "photo" ? "image/jpeg" : "application/octet-stream");
  const filename =
    attachment.fileName ?? (attachment.kind === "photo" ? `photo-${index}.jpg` : `file-${index}`);

  return {
    data: createTelegramFileUrl({
      fileId: attachment.fileId,
      filename,
      mediaType,
    }),
    filename,
    mediaType,
    type: "file",
  };
}

function parseTelegramFileUrl(
  url: string,
): { readonly fileId: string; readonly filename?: string; readonly mediaType?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== TELEGRAM_FILE_URL_PROTOCOL) return null;
  const fileId = decodeURIComponent(parsed.pathname);
  if (!fileId) return null;
  return {
    fileId,
    filename: parsed.searchParams.get("filename") ?? undefined,
    mediaType: parsed.searchParams.get("mediaType") ?? undefined,
  };
}

function evaluateTelegramFilePart(
  part: FilePart,
  size: number | undefined,
  policy: UploadPolicy,
): ReturnType<typeof evaluateFilePart> {
  if (policy === "disabled" || !isMediaTypeAllowed(part.mediaType, policy)) {
    return evaluateFilePart(part, policy);
  }
  if (size !== undefined && size > policy.maxBytes) {
    return {
      byteLength: size,
      filename: part.filename,
      kind: "too-large",
      limit: policy.maxBytes,
      mediaType: part.mediaType,
    };
  }
  return null;
}
