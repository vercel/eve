import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

export const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const ASYNC_INLINE_INPUT_LIMIT_BYTES = 180 * 1024;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MPEG_SYNC = new Set([0xfb, 0xf3, 0xf2, 0xe3, 0xfa]);
const STILL_ISOBMFF = new Set("avif avis heic heix hevc hevx mif1 msf1".split(" "));
const EXT_TYPES: Record<string, string> = Object.fromEntries(
  ".mp4=video/mp4 .webm=video/webm .mov=video/quicktime .png=image/png .jpg=image/jpeg .jpeg=image/jpeg .webp=image/webp .gif=image/gif .mp3=audio/mpeg .wav=audio/wav .ogg=audio/ogg .flac=audio/flac .m4a=audio/mp4"
    .split(" ")
    .map((p) => p.split("=")),
);
const RES_PRESETS: Record<string, readonly `${number}x${number}`[]> = {
  "480p": ["854x480", "480x854", "480x480"],
  "720p": ["1280x720", "720x1280", "720x720"],
  "1080p": ["1920x1080", "1080x1920", "1080x1080"],
  "4k": ["3840x2160", "2160x3840", "2160x2160"],
};
const PRIVATE_IPS = (() => {
  const list = new BlockList();
  for (const c of "0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4".split(
    " ",
  ))
    list.addSubnet(c.split("/")[0], Number(c.split("/")[1]), "ipv4");
  for (const c of "::/96 ::ffff:0:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 2001::/23 2001:db8::/32 2002::/16 fc00::/7 fe80::/10 fec0::/10 ff00::/8".split(
    " ",
  ))
    list.addSubnet(c.split("/")[0], Number(c.split("/")[1]), "ipv6");
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  return list;
})();

export type DnsLookupFn = (
  host: string,
  opts: { readonly all: true },
) => Promise<readonly { readonly address: string; readonly family?: number }[]>;
export const normalizeMediaType = (t: string): string => t.split(";", 1)[0].trim().toLowerCase();

export function detectMediaType(b: Uint8Array): string | undefined {
  const h = Buffer.from(b.buffer, b.byteOffset, Math.min(b.byteLength, 12)).toString("latin1");
  if (h.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (b.byteLength >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (h.startsWith("GIF87a") || h.startsWith("GIF89a")) return "image/gif";
  if (h.startsWith("RIFF") && h.length >= 12)
    return h.slice(8) === "WEBP" ? "image/webp" : h.slice(8) === "WAVE" ? "audio/wav" : undefined;
  if (h.startsWith("OggS")) return "audio/ogg";
  if (h.startsWith("fLaC")) return "audio/flac";
  if (h.startsWith("ID3") || (b.byteLength >= 2 && b[0] === 0xff && MPEG_SYNC.has(b[1])))
    return "audio/mpeg";
  if (h.startsWith("\x1a\x45\xdf\xa3")) return "video/webm";
  if (h.length >= 12 && h.slice(4, 8) === "ftyp" && !STILL_ISOBMFF.has(h.slice(8))) {
    const br = h.slice(8);
    return br === "qt  "
      ? "video/quicktime"
      : br === "M4A " || br === "M4B "
        ? "audio/mp4"
        : "video/mp4";
  }
  return undefined;
}

export const extensionForMediaType = (t: string): string => {
  const n = normalizeMediaType(t);
  return (
    Object.entries(EXT_TYPES).find(([, v]) => v === n)?.[0] ??
    (n.startsWith("video/") ? ".mp4" : ".bin")
  );
};

export const mediaTypeForPath = (p: string): string | undefined => {
  const seg = p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  const dot = seg.lastIndexOf(".");
  return dot > 0 ? EXT_TYPES[seg.slice(dot).toLowerCase()] : undefined;
};

export const mediaTypeFromUrl = (url: string): string | undefined => {
  try {
    return mediaTypeForPath(new URL(url).pathname);
  } catch {
    return undefined;
  }
};

export const mediaKind = (t: string): "image" | "video" | "audio" | "other" => {
  const p = normalizeMediaType(t).split("/", 1)[0];
  return p === "image" || p === "video" || p === "audio" ? p : "other";
};

export function normalizeAspectRatio(value: string): `${number}:${number}` | "adaptive" {
  const t = value.trim().toLowerCase();
  if (t === "auto" || t === "adaptive") return "adaptive";
  const m = /^([1-9]\d*):([1-9]\d*)$/.exec(t);
  if (m) return `${Number(m[1])}:${Number(m[2])}`;
  throw new Error(`Invalid aspectRatio "${value}".`);
}

export function normalizeResolution(
  value: string,
  ratio?: `${number}:${number}` | "adaptive",
): `${number}x${number}` {
  const t = value.trim().toLowerCase();
  const m = /^([1-9]\d*)x([1-9]\d*)$/.exec(t);
  if (m) return `${Number(m[1])}x${Number(m[2])}`;
  const p = RES_PRESETS[t === "2160p" ? "4k" : t];
  if (!p) throw new Error(`Invalid resolution "${value}".`);
  if (!ratio || ratio === "adaptive") return p[0];
  const [w, h] = ratio.split(":").map(Number);
  return w < h ? p[1] : w === h ? p[2] : p[0];
}

export function videoPath(filePath: string, index: number): string {
  if (!index) return filePath;
  const sep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return dot > sep + 1
    ? `${filePath.slice(0, dot)}-${index}${filePath.slice(dot)}`
    : `${filePath}-${index}`;
}

export const isUrlLike = (v: string): boolean =>
  /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v.trim()) && !/^[a-zA-Z]:[\\/]/.test(v.trim());

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
  if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS URL "${rawUrl}".`);
  if (url.username || url.password)
    throw new Error(`Refusing URL with credentials: "${url.origin}".`);
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) throw new Error(`Invalid URL hostname: "${rawUrl}".`);
  if (host === "localhost" || /\.(?:localhost|local|internal)$/.test(host))
    throw new Error(`Refusing local host "${url.hostname}".`);
  const bare = stripIp(host);
  if (isIP(bare) !== 0) {
    if (isPrivateIp(bare)) throw new Error(`Refusing private or reserved IP address "${bare}".`);
    return url;
  }
  if (options?.resolveDns !== false) await resolvePublicAddresses(bare, options?.lookup);
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
  if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0)
    throw new Error(`Invalid maxBytes: ${options.maxBytes}.`);
  let currentUrl = url;
  for (let redirects = 0; ; redirects += 1) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(300_000)]);
    const safeUrl = await assertSafePublicUrl(currentUrl, {
      resolveDns: Boolean(options.fetch),
      lookup: options.lookup,
    });
    const fRes = options.fetch
      ? await options.fetch(safeUrl.href, { method: "GET", redirect: "manual", signal })
      : undefined;
    const nRes = fRes ? undefined : await openHttps(safeUrl, signal, options.lookup);
    const status = fRes ? fRes.status : (nRes!.statusCode ?? 0);
    const hdr = (k: string) =>
      fRes ? (fRes.headers.get(k) ?? undefined) : [nRes!.headers[k]].flat()[0];
    const cancel = () => (fRes ? fRes.body?.cancel().catch(() => undefined) : void nRes!.destroy());

    if (REDIRECTS.has(status)) {
      await cancel();
      const next = hdr("location")?.trim();
      if (!next) throw new Error(`Redirect (HTTP ${status}) missing Location header.`);
      if (redirects >= 5) throw new Error("Too many redirects (maximum 5).");
      try {
        currentUrl = new URL(next, safeUrl).href;
      } catch {
        throw new Error(`Invalid redirect Location header "${next}".`);
      }
      continue;
    }
    if (status < 200 || status >= 300) {
      await cancel();
      throw Object.assign(new Error(`Download failed: HTTP ${status}.`), { statusCode: status });
    }
    const len = Number(hdr("content-length")?.trim() || Number.NaN);
    if (Number.isFinite(len) && len > options.maxBytes) {
      await cancel();
      throw new Error(`Video exceeds ${options.maxBytes} bytes (Content-Length: ${len}).`);
    }
    const body = fRes ? fRes.body : nRes!;
    const onAbort = nRes
      ? (err: Error) => (nRes.listenerCount("error") > 0 ? nRes.destroy(err) : nRes.destroy())
      : undefined;
    const data = body
      ? await readBoundedStream(body, options.maxBytes, { signal, onAbortOrOverflow: onAbort })
      : new Uint8Array(0);
    return { data, mediaType: normalizeMediaType(hdr("content-type") ?? "") || undefined };
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
  options?: { readonly signal?: AbortSignal; readonly onAbortOrOverflow?: (error: Error) => void },
): Promise<Uint8Array> {
  const signal = options?.signal;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abortErr = () =>
    signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted.", "AbortError");
  const reader = "getReader" in stream ? stream.getReader() : undefined;
  const cancel = (err: Error) =>
    reader ? void reader.cancel(err).catch(() => undefined) : options?.onAbortOrOverflow?.(err);
  const onAbort = () => cancel(abortErr());
  signal?.addEventListener("abort", onAbort, { once: true });
  const push = (bytes: Uint8Array) => {
    if ((total += bytes.byteLength) > maxBytes) {
      const err = new StreamLimitExceededError(maxBytes);
      cancel(err);
      throw err;
    }
    chunks.push(bytes);
  };
  try {
    if (signal?.aborted) {
      cancel(abortErr());
      throw abortErr();
    }
    if (reader) for (let r = await reader.read(); !r.done; r = await reader.read()) push(r.value);
    else for await (const c of stream) push(typeof c === "string" ? Buffer.from(c) : c);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader?.releaseLock();
  }
  if (signal?.aborted) throw abortErr();
  const buf = Buffer.concat(chunks, total);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function openHttps(
  safeUrl: URL,
  signal: AbortSignal,
  lookup?: DnsLookupFn,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    httpsRequest(
      safeUrl,
      {
        method: "GET",
        signal,
        lookup: (host, opts, cb) => {
          void resolvePublicAddresses(host, lookup).then(
            (recs) => {
              const c = opts.family ? recs.filter((x) => x.family === opts.family) : recs;
              const p = c.length ? c : recs;
              if (opts.all) cb(null, p);
              else cb(null, p[0].address, p[0].family);
            },
            (err: unknown) => cb(err instanceof Error ? err : new Error(String(err)), ""),
          );
        },
      },
      resolve,
    )
      .once("error", reject)
      .end();
  });
}

async function resolvePublicAddresses(
  hostname: string,
  lookup?: DnsLookupFn,
): Promise<LookupAddress[]> {
  const records = lookup
    ? await lookup(hostname, { all: true })
    : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error(`Could not resolve URL host "${hostname}".`);
  return records.map((r) => {
    if (isPrivateIp(r.address))
      throw new Error(`Host "${hostname}" resolves to a private or reserved IP address.`);
    return { address: r.address, family: (r.family ?? isIP(stripIp(r.address))) === 6 ? 6 : 4 };
  });
}

const stripIp = (a: string) => a.trim().replace(/^\[|(?:%[^]]*)?\]$|%.*$/g, "");
const isPrivateIp = (a: string) => {
  const n = stripIp(a);
  const f = isIP(n);
  return f !== 0 && PRIVATE_IPS.check(n, f === 4 ? "ipv4" : "ipv6");
};
