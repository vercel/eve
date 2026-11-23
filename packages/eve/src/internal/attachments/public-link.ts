import { requestPublicUrl } from "#execution/web-fetch/request.js";
import { EveAttachmentError } from "#internal/attachments/errors.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOADS_PER_MESSAGE = 10;
const GENERIC_MEDIA_TYPES = new Set(["application/octet-stream", "binary/octet-stream"]);

export interface DownloadedFile {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export type PublicDownloads = (url: URL, adapterKind: string) => Promise<DownloadedFile>;

export function createPublicDownloads(maxBytes: number): PublicDownloads {
  let started = 0;
  let previous: Promise<unknown> = Promise.resolve();
  return async (url, adapterKind) => {
    if (url.protocol === "https:" && ++started > MAX_DOWNLOADS_PER_MESSAGE) {
      throw refusal(
        adapterKind,
        `eve downloads at most ${MAX_DOWNLOADS_PER_MESSAGE} links per message.`,
      );
    }
    const download = previous.then(() => fetchPublicAttachment(url, adapterKind, maxBytes));
    previous = download.catch(() => undefined);
    return await download;
  };
}

async function fetchPublicAttachment(
  url: URL,
  adapterKind: string,
  maxBytes: number,
): Promise<DownloadedFile> {
  if (url.protocol !== "https:") {
    throw refusal(adapterKind, "eve downloads only public https:// links.");
  }
  let response: Response;
  try {
    response = await requestPublicUrl(url.href, {
      headers: {},
      maxResponseSize: maxBytes,
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    throw refusal(adapterKind, "The link could not be downloaded.", cause);
  }
  if (!response.ok) {
    throw refusal(adapterKind, `The link returned HTTP ${response.status}.`);
  }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "text/html") {
    throw refusal(adapterKind, "The link returned a web page instead of a file.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return mediaType === undefined || mediaType === "" || GENERIC_MEDIA_TYPES.has(mediaType)
    ? { bytes }
    : { bytes, mediaType };
}

function refusal(adapterKind: string, message: string, cause?: unknown): EveAttachmentError {
  return new EveAttachmentError({ adapterKind, cause, kind: "resolver-threw", message });
}
