import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const ASYNC_INLINE_INPUT_LIMIT_BYTES = 180 * 1024;

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MPEG_SYNC_SECOND_BYTES = new Set([0xfb, 0xf3, 0xf2, 0xe3, 0xfa]);
const STILL_ISOBMFF_BRANDS = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
]);
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:[\\/]/;

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
};

const RESOLUTION_PRESETS: Readonly<
  Record<string, readonly [`${number}x${number}`, `${number}x${number}`, `${number}x${number}`]>
> = {
  "480p": ["854x480", "480x854", "480x480"],
  "720p": ["1280x720", "720x1280", "720x720"],
  "1080p": ["1920x1080", "1080x1920", "1080x1080"],
  "4k": ["3840x2160", "2160x3840", "2160x2160"],
  "2160p": ["3840x2160", "2160x3840", "2160x2160"],
};

const PRIVATE_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

const PRIVATE_IPV6_CIDRS = [
  "::/96",
  "::ffff:0:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
] as const;

const PRIVATE_IP_BLOCKLIST = createPrivateIpBlockList();

export type DnsLookupFn = (
  hostname: string,
  options: { readonly all: true },
) => Promise<readonly { readonly address: string; readonly family?: number }[]>;

export function normalizeMediaType(mediaType: string): string {
  const semicolonIndex = mediaType.indexOf(";");
  return (semicolonIndex === -1 ? mediaType : mediaType.slice(0, semicolonIndex))
    .trim()
    .toLowerCase();
}

export function detectMediaType(bytes: Uint8Array): string | undefined {
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (matchesAscii(bytes, 0, "GIF87a") || matchesAscii(bytes, 0, "GIF89a")) return "image/gif";
  if (bytes.byteLength >= 12 && matchesAscii(bytes, 0, "RIFF")) {
    if (matchesAscii(bytes, 8, "WEBP")) return "image/webp";
    if (matchesAscii(bytes, 8, "WAVE")) return "audio/wav";
  }
  if (matchesAscii(bytes, 0, "OggS")) return "audio/ogg";
  if (matchesAscii(bytes, 0, "fLaC")) return "audio/flac";
  if (
    matchesAscii(bytes, 0, "ID3") ||
    (bytes.byteLength >= 2 && bytes[0] === 0xff && MPEG_SYNC_SECOND_BYTES.has(bytes[1]))
  ) {
    return "audio/mpeg";
  }
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "video/webm";
  }
  if (bytes.byteLength >= 12 && matchesAscii(bytes, 4, "ftyp")) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (STILL_ISOBMFF_BRANDS.has(brand)) return undefined;
    if (brand === "qt  ") return "video/quicktime";
    if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
    return "video/mp4";
  }
  return undefined;
}

export function extensionForMediaType(mediaType: string): string {
  const normalized = normalizeMediaType(mediaType);
  for (const [ext, type] of Object.entries(EXTENSION_MEDIA_TYPES)) {
    if (type === normalized) return ext;
  }
  return normalized.startsWith("video/") ? ".mp4" : ".bin";
}

export function mediaTypeForPath(filePath: string): string | undefined {
  const lastSegment = filePath.slice(
    Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1,
  );
  const dotIndex = lastSegment.lastIndexOf(".");
  return dotIndex > 0
    ? EXTENSION_MEDIA_TYPES[lastSegment.slice(dotIndex).toLowerCase()]
    : undefined;
}

export function mediaTypeFromUrl(url: string): string | undefined {
  try {
    return mediaTypeForPath(new URL(url).pathname);
  } catch {
    return undefined;
  }
}

export function mediaKind(mediaType: string): "image" | "video" | "audio" | "other" {
  const normalized = normalizeMediaType(mediaType);
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized.startsWith("audio/")) return "audio";
  return "other";
}

export function normalizeAspectRatio(value: string): `${number}:${number}` | "adaptive" {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "auto" || trimmed === "adaptive") return "adaptive";
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(trimmed);
  if (match !== null) return `${Number(match[1])}:${Number(match[2])}`;
  throw new Error(
    `Invalid aspectRatio "${value}". Use "width:height" such as "16:9" or "9:16", or "auto".`,
  );
}

export function normalizeResolution(
  value: string,
  aspectRatio?: `${number}:${number}` | "adaptive",
): `${number}x${number}` {
  const trimmed = value.trim().toLowerCase();
  const explicit = /^([1-9]\d*)x([1-9]\d*)$/.exec(trimmed);
  if (explicit !== null) return `${Number(explicit[1])}x${Number(explicit[2])}`;
  const preset = RESOLUTION_PRESETS[trimmed];
  if (preset === undefined) {
    throw new Error(
      `Invalid resolution "${value}". Use "480p", "720p", "1080p", "4k", or "widthxheight" such as "1280x720".`,
    );
  }
  if (aspectRatio === undefined || aspectRatio === "adaptive") return preset[0];
  const [w, h] = aspectRatio.split(":").map(Number);
  return w < h ? preset[1] : w === h ? preset[2] : preset[0];
}

export function videoPath(filePath: string, index: number): string {
  if (index === 0) return filePath;
  const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dotIndex = filePath.lastIndexOf(".");
  return dotIndex > lastSep + 1
    ? `${filePath.slice(0, dotIndex)}-${index}${filePath.slice(dotIndex)}`
    : `${filePath}-${index}`;
}

export function isUrlLike(value: string): boolean {
  const trimmed = value.trim();
  return URL_SCHEME_PATTERN.test(trimmed) && !WINDOWS_DRIVE_PATTERN.test(trimmed);
}

function isPrivateIpAddress(address: string): boolean {
  const normalized = stripBracketsAndZone(address);
  const family = isIP(normalized);
  return family !== 0 && PRIVATE_IP_BLOCKLIST.check(normalized, family === 4 ? "ipv4" : "ipv6");
}

export async function assertSafePublicUrl(
  rawUrl: string,
  options?: { readonly resolveDns?: boolean; readonly lookup?: DnsLookupFn },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}".`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Refusing non-HTTPS URL "${rawUrl}". Only https:// URLs are allowed.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Refusing URL with embedded credentials: "${url.origin}".`);
  }
  const normalizedHost = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (normalizedHost.length === 0) throw new Error(`Invalid URL hostname: "${rawUrl}".`);
  if (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".internal")
  ) {
    throw new Error(`Refusing private or local URL host "${url.hostname}".`);
  }
  const bareHost = stripBracketsAndZone(normalizedHost);
  if (isIP(bareHost) !== 0) {
    if (isPrivateIpAddress(bareHost)) {
      throw new Error(`Refusing private or reserved IP address "${bareHost}".`);
    }
    return url;
  }
  if (options?.resolveDns !== false) {
    await resolveValidatedAddresses(bareHost, options?.lookup);
  }
  return url;
}

export async function downloadVideoBytes(
  url: string,
  options: {
    readonly maxBytes: number;
    readonly signal: AbortSignal;
    readonly fetch?: typeof fetch;
    readonly lookup?: DnsLookupFn;
  },
): Promise<{ readonly data: Uint8Array; readonly mediaType: string | undefined }> {
  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`Invalid maxBytes limit: ${options.maxBytes}.`);
  }
  let currentUrl = url;
  for (let redirects = 0; ; redirects += 1) {
    const requestSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    ]);
    const safeUrl = await assertSafePublicUrl(currentUrl, {
      resolveDns: options.fetch !== undefined,
      lookup: options.lookup,
    });
    const response =
      options.fetch !== undefined
        ? await openFetchResponse(safeUrl, requestSignal, options.fetch)
        : await openHttpsResponse(safeUrl, requestSignal, options.lookup);

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.cancel();
      const location = response.location?.trim();
      if (location === undefined || location.length === 0) {
        throw new Error(`Redirect response (HTTP ${response.status}) missing Location header.`);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects while downloading video (maximum ${MAX_REDIRECTS}).`);
      }
      try {
        currentUrl = new URL(location, safeUrl).href;
      } catch {
        throw new Error(`Invalid redirect Location header "${location}".`);
      }
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.cancel();
      throw Object.assign(new Error(`Failed to download video: HTTP ${response.status}.`), {
        statusCode: response.status,
      });
    }
    if (response.contentLength !== undefined && response.contentLength > options.maxBytes) {
      await response.cancel();
      throw new Error(
        `Downloaded video exceeds maximum allowed size of ${options.maxBytes} bytes (Content-Length: ${response.contentLength} bytes).`,
      );
    }
    return { data: await response.readBytes(options.maxBytes), mediaType: response.mediaType };
  }
}

export class StreamLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Downloaded video exceeds maximum allowed size of ${maxBytes} bytes.`);
  }
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>,
  maxBytes: number,
  options?: {
    readonly signal?: AbortSignal;
    readonly onAbortOrOverflow?: (error: Error) => void;
  },
): Promise<Uint8Array> {
  const signal = options?.signal;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const toAbortError = () =>
    signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  const reader = "getReader" in stream ? stream.getReader() : undefined;
  const abortStream = (error: Error) => {
    if (reader !== undefined) {
      void reader.cancel(error).catch(() => undefined);
    } else {
      options?.onAbortOrOverflow?.(error);
    }
  };
  if (signal?.aborted) {
    const error = toAbortError();
    abortStream(error);
    reader?.releaseLock();
    throw error;
  }
  const onAbort = () => abortStream(toAbortError());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          const error = new StreamLimitExceededError(maxBytes);
          await reader.cancel(error).catch(() => undefined);
          throw error;
        }
        chunks.push(value);
      }
    } else {
      for await (const chunk of stream) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        total += bytes.byteLength;
        if (total > maxBytes) {
          const error = new StreamLimitExceededError(maxBytes);
          options?.onAbortOrOverflow?.(error);
          throw error;
        }
        chunks.push(bytes);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
  if (signal?.aborted) {
    throw toAbortError();
  }
  const merged = Buffer.concat(chunks, total);
  return new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength);
}

interface DownloadHandle {
  readonly status: number;
  readonly location?: string;
  readonly contentLength?: number;
  readonly mediaType?: string;
  readonly readBytes: (maxBytes: number) => Promise<Uint8Array>;
  readonly cancel: () => Promise<void>;
}

async function resolveValidatedAddresses(
  hostname: string,
  lookup?: DnsLookupFn,
): Promise<LookupAddress[]> {
  const records =
    lookup !== undefined
      ? await lookup(hostname, { all: true })
      : await dnsLookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error(`Could not resolve URL host "${hostname}".`);
  return records.map((record) => {
    if (isPrivateIpAddress(record.address)) {
      throw new Error(
        `Refusing URL host "${hostname}" because it resolves to a private or reserved IP address.`,
      );
    }
    const family = record.family ?? isIP(stripBracketsAndZone(record.address));
    return { address: record.address, family: family === 6 ? 6 : 4 };
  });
}

function createPinnedLookup(lookup?: DnsLookupFn) {
  return (
    hostname: string,
    lookupOptions: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    void resolveValidatedAddresses(hostname, lookup).then(
      (records) => {
        const matching =
          lookupOptions.family === 4 || lookupOptions.family === 6
            ? records.filter((record) => record.family === lookupOptions.family)
            : records;
        const chosen = matching.length > 0 ? matching : records;
        if (lookupOptions.all) callback(null, chosen);
        else callback(null, chosen[0].address, chosen[0].family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ""),
    );
  };
}

async function openFetchResponse(
  safeUrl: URL,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<DownloadHandle> {
  const response = await fetchImpl(safeUrl.href, { method: "GET", redirect: "manual", signal });
  return buildDownloadHandle({
    status: response.status,
    location: response.headers.get("location"),
    contentLength: response.headers.get("content-length"),
    contentType: response.headers.get("content-type"),
    readBytes: async (maxBytes) =>
      response.body === null
        ? new Uint8Array(0)
        : readBoundedStream(response.body, maxBytes, { signal }),
    cancel: async () => {
      await response.body?.cancel().catch(() => undefined);
    },
  });
}

function openHttpsResponse(
  safeUrl: URL,
  signal: AbortSignal,
  lookup?: DnsLookupFn,
): Promise<DownloadHandle> {
  return new Promise<DownloadHandle>((resolve, reject) => {
    const req = httpsRequest(
      safeUrl,
      { method: "GET", signal, lookup: createPinnedLookup(lookup) },
      (res) => {
        resolve(
          buildDownloadHandle({
            status: res.statusCode ?? 0,
            location: firstHeaderValue(res.headers.location),
            contentLength: firstHeaderValue(res.headers["content-length"]),
            contentType: firstHeaderValue(res.headers["content-type"]),
            readBytes: (maxBytes) =>
              readBoundedStream(res, maxBytes, {
                signal,
                onAbortOrOverflow: (err) => {
                  if (res.listenerCount("error") > 0) {
                    res.destroy(err);
                  } else {
                    res.destroy();
                  }
                },
              }),
            cancel: async () => {
              res.destroy();
            },
          }),
        );
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function buildDownloadHandle(input: {
  readonly status: number;
  readonly location: string | null | undefined;
  readonly contentLength: string | null | undefined;
  readonly contentType: string | null | undefined;
  readonly readBytes: (maxBytes: number) => Promise<Uint8Array>;
  readonly cancel: () => Promise<void>;
}): DownloadHandle {
  const rawLength = input.contentLength?.trim();
  const parsed = rawLength ? Number(rawLength) : Number.NaN;
  const contentLength = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  const mediaType = input.contentType
    ? normalizeMediaType(input.contentType) || undefined
    : undefined;
  return {
    status: input.status,
    ...(typeof input.location === "string" && { location: input.location }),
    ...(contentLength !== undefined && { contentLength }),
    ...(mediaType !== undefined && { mediaType }),
    readBytes: input.readBytes,
    cancel: input.cancel,
  };
}

function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

function createPrivateIpBlockList(): BlockList {
  const list = new BlockList();
  for (const cidr of PRIVATE_IPV4_CIDRS) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv4");
  }
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  for (const cidr of PRIVATE_IPV6_CIDRS) {
    const [address, prefix] = cidr.split("/");
    list.addSubnet(address, Number(prefix), "ipv6");
  }
  return list;
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.byteLength < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function stripBracketsAndZone(address: string): string {
  const trimmed = address.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const zoneIndex = unbracketed.indexOf("%");
  return zoneIndex === -1 ? unbracketed : unbracketed.slice(0, zoneIndex);
}
