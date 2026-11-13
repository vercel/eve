"use server";

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { z } from "zod";

import { hasAccess } from "@/lib/session";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;
const MAX_CACHED = 500;

const MAX_REDIRECTS = 3;

const IMAGE_KEYS = [
  "og:image",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
];

const HEAD_END_PATTERN = /<\/head>/iu;
const META_TAG_PATTERN = /<meta\b[^<>]{0,2048}>/giu;
const KEY_ATTRIBUTE_PATTERN =
  /\s(?:property|name)\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/iu;
const CONTENT_ATTRIBUTE_PATTERN =
  /\scontent\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)')/iu;

const cache = new Map<string, Promise<string | null>>();

/** Addresses the server must never connect to: private, loopback, link-local, and reserved ranges. */
const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
// No `::ffff:0:0/96`: BlockList already checks IPv4-mapped addresses against the
// IPv4 rules above, and that subnet would match every IPv4 address.
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isPublicAddress({ address, family }: LookupAddress): boolean {
  return !BLOCKED_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Resolves a host name for the socket and refuses it unless every address is
 * public. The connection uses the checked address, so DNS rebinding can't swap
 * in a private one between the check and the connect.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const [first] = addresses;
    if (first === undefined || !addresses.every(isPublicAddress)) {
      callback(
        Object.assign(new Error(`${hostname} resolves to a non-public address.`), {
          code: "EADDRNOTPUBLIC",
        }),
        "",
        0,
      );
      return;
    }
    if (options.all) {
      (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
    } else {
      callback(null, first.address, first.family);
    }
  });
};

/**
 * Checks that a URL is worth fetching: https on a host name, not an IP
 * literal (sockets skip the lookup for those) or a local name. Where the name
 * resolves is checked at connect time by {@link publicLookup}.
 *
 * @param url - The URL to check.
 * @returns Whether the server may fetch it.
 */
function isFetchable(url: URL): boolean {
  const host = url.hostname.replace(/\.$/u, "");
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    host.includes(".") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal") &&
    !host.endsWith(".localhost") &&
    isIP(host.replace(/^\[|\]$/gu, "")) === 0
  );
}

/**
 * Sends a GET over https, connecting only to public addresses.
 *
 * @param url - The URL to fetch.
 * @param signal - Aborts the request.
 * @returns The response, with its body unread.
 */
function get(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      // Many CDNs reject requests without a User-Agent.
      headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (compatible; eve-preview/1.0)" },
      lookup: publicLookup,
      signal,
    });
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

/**
 * Fetches a page, following up to {@link MAX_REDIRECTS} redirects itself so
 * that every hop passes {@link isFetchable} and {@link publicLookup}.
 *
 * @param url - The URL to fetch.
 * @param signal - Aborts the request and every redirect after it.
 * @param hops - The redirects followed so far.
 * @returns The final response and its URL, or `null` when a hop isn't
 * fetchable or there are too many redirects.
 * @throws {@link Error} When a request fails or the final response isn't OK.
 */
async function fetchPage(
  url: URL,
  signal: AbortSignal,
  hops: number
): Promise<{ response: IncomingMessage; url: URL } | null> {
  if (!isFetchable(url)) {
    return null;
  }
  const response = await get(url, signal);
  const status = response.statusCode ?? 0;
  const { location } = response.headers;
  if (status >= 300 && status < 400 && location !== undefined) {
    response.destroy();
    if (hops >= MAX_REDIRECTS || !URL.canParse(location, url)) {
      return null;
    }
    return await fetchPage(new URL(location, url), signal, hops + 1);
  }
  if (status < 200 || status >= 300) {
    response.destroy();
    throw new Error(`Preview page responded with ${status}.`);
  }
  return { response, url };
}

/**
 * Reads an attribute value from a single meta tag.
 *
 * @param tag - The meta tag's source.
 * @param pattern - Matches the attribute, with the value in the `double` or
 * `single` group.
 * @returns The attribute value, or `undefined` when the tag lacks it.
 */
function readAttribute(tag: string, pattern: RegExp): string | undefined {
  const groups = pattern.exec(tag)?.groups;
  return groups?.double ?? groups?.single;
}

/**
 * Finds the preview image in a page's head, preferring `og:image`, then
 * `og:image:secure_url`, `twitter:image`, and `twitter:image:src`.
 *
 * @param html - The start of the page.
 * @returns The raw image URL from the first matching meta tag, or `undefined`.
 */
function findImageMeta(html: string): string | undefined {
  const headEnd = html.search(HEAD_END_PATTERN);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);
  const images = new Map<string, string>();
  for (const [tag] of head.matchAll(META_TAG_PATTERN)) {
    const key = readAttribute(tag, KEY_ATTRIBUTE_PATTERN)?.toLowerCase();
    const content = readAttribute(tag, CONTENT_ATTRIBUTE_PATTERN);
    if (
      key !== undefined &&
      content !== undefined &&
      content !== "" &&
      IMAGE_KEYS.includes(key) &&
      !images.has(key)
    ) {
      images.set(key, content);
    }
  }
  return IMAGE_KEYS.map((key) => images.get(key)).find(
    (image) => image !== undefined
  );
}

/**
 * Reads the start of a response body, until the page's head has arrived or
 * {@link MAX_BYTES} have been read.
 *
 * @param response - The page response.
 * @returns The decoded text.
 */
async function readHead(response: IncomingMessage): Promise<string> {
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  try {
    for await (const chunk of response as AsyncIterable<Uint8Array>) {
      html += decoder.decode(chunk, { stream: true });
      bytes += chunk.byteLength;
      if (bytes >= MAX_BYTES || html.includes("</head>")) {
        break;
      }
    }
  } finally {
    response.destroy();
  }
  return html;
}

/**
 * Fetches a page and finds its preview image from its `og:image` or
 * `twitter:image` meta tag.
 *
 * @param pageUrl - The page to read.
 * @returns The absolute https image URL, or `null` when there is none.
 * @throws {@link Error} When the page can't be fetched, times out, or responds with an error.
 */
async function findPreviewImage(pageUrl: string): Promise<string | null> {
  const page = await fetchPage(
    new URL(pageUrl),
    AbortSignal.timeout(TIMEOUT_MS),
    0
  );
  if (page === null) {
    return null;
  }
  const match = findImageMeta(await readHead(page.response));
  if (match === undefined) {
    return null;
  }
  const source = match.replaceAll("&amp;", "&");
  if (!URL.canParse(source, page.url)) {
    return null;
  }
  const image = new URL(source, page.url);
  return image.protocol === "https:" ? image.href : null;
}

/**
 * Runs {@link findPreviewImage} and removes the cached lookup when it fails, so
 * a transient failure is retried on the next request.
 *
 * @param pageUrl - The page to read.
 * @returns The image URL, or `null` when there is none or the lookup failed.
 */
async function lookupPreviewImage(pageUrl: string): Promise<string | null> {
  try {
    return await findPreviewImage(pageUrl);
  } catch {
    cache.delete(pageUrl);
    return null;
  }
}

const inputSchema = z.object({ data: z.object({ url: z.url() }) });

/**
 * Server Action that returns a page's preview image for a browser with access
 * to the chat. Each URL is fetched at most once per server instance, except
 * after a failed fetch, which the next request retries.
 *
 * @param input - The page URL, as `{ data: { url } }`.
 * @returns The image URL, or `null` when the page has none, can't be read, or
 * the browser lacks access.
 */
export async function getPreviewImage(input: {
  readonly data: { readonly url: string };
}): Promise<string | null> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || !(await hasAccess())) {
    return null;
  }
  const { url } = parsed.data.data;
  const cached = cache.get(url);
  if (cached !== undefined) {
    return await cached;
  }
  if (cache.size >= MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  const lookup = lookupPreviewImage(url);
  cache.set(url, lookup);
  return await lookup;
}
