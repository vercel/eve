import type { FetchFileResult } from "#channel/adapter.js";
import { requestPublicUrl } from "#execution/web-fetch/request.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";
import { DEFAULT_UPLOAD_POLICY } from "#public/channels/upload-policy.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Links eve downloads for one message. Each buffers up to the upload cap, so they run one at a time. */
const MAX_DOWNLOADS_PER_MESSAGE = 10;
const GENERIC_MEDIA_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

/** Downloads one message's unclaimed links: at most {@link MAX_DOWNLOADS_PER_MESSAGE}, one at a time. */
export type PublicDownloads = (url: URL, adapterKind: string) => Promise<FetchFileResult>;

/** Starts the download budget for one message's attachments. */
export function createPublicDownloads(): PublicDownloads {
  let started = 0;
  let previous: Promise<unknown> = Promise.resolve();
  return async (url, adapterKind) => {
    if (url.protocol === "https:" && ++started > MAX_DOWNLOADS_PER_MESSAGE) {
      throw refusal(
        adapterKind,
        `eve downloads at most ${MAX_DOWNLOADS_PER_MESSAGE} links per message.`,
      );
    }
    const download = previous.then(() => fetchPublicAttachment(url, adapterKind));
    previous = download.catch(() => undefined);
    return await download;
  };
}

/**
 * Downloads an attachment link that no channel resolver claimed, so a
 * provider never fetches it and an unreachable link fails as a note instead
 * of on every later model call. Only public `https:` destinations qualify;
 * private and reserved addresses are refused.
 */
async function fetchPublicAttachment(url: URL, adapterKind: string): Promise<FetchFileResult> {
  if (url.protocol !== "https:") {
    throw refusal(adapterKind, "eve downloads only public https:// links.");
  }
  let response: Response;
  try {
    response = await requestPublicUrl(url.href, {
      headers: {},
      maxResponseSize: DEFAULT_UPLOAD_POLICY.maxBytes,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw refusal(adapterKind, "The link could not be downloaded.", cause);
  }
  if (!response.ok) {
    throw refusal(adapterKind, `The link returned HTTP ${response.status}.`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // A private document's link usually answers with a sign-in page.
  if (mediaType === "text/html") {
    throw refusal(adapterKind, "The link returned a web page instead of a file.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return mediaType === undefined || mediaType === "" || GENERIC_MEDIA_TYPES.has(mediaType)
    ? { bytes }
    : { bytes, mediaType };
}

function refusal(adapterKind: string, message: string, cause?: unknown): EveAttachmentError {
  return new EveAttachmentError({ adapterKind, cause, kind: "resolver-threw", message });
}
