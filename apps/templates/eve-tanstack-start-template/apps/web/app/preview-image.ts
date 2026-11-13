import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { resolveAccessStatus } from "./access";

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

/**
 * Checks that a URL is safe for the server to fetch: https on a public host
 * name, not an IP address or a local name.
 *
 * @param url - The URL to check.
 * @returns Whether the server may fetch it.
 */
function isFetchable(url: URL): boolean {
  const host = url.hostname;
  return (
    url.protocol === "https:" &&
    host.includes(".") &&
    !host.endsWith(".local") &&
    !host.endsWith(".internal") &&
    !/^[\d.]+$/u.test(host) &&
    !host.includes(":")
  );
}

/**
 * Fetches a page, following up to {@link MAX_REDIRECTS} redirects itself so
 * that every hop passes {@link isFetchable}.
 *
 * @param url - The URL to fetch.
 * @param signal - Aborts the request and every redirect after it.
 * @param hops - The redirects followed so far.
 * @returns The final response, or `null` when a hop isn't fetchable or there
 * are too many redirects.
 * @throws {@link Error} When a request fails or the final response isn't OK.
 */
async function fetchPage(
  url: URL,
  signal: AbortSignal,
  hops: number
): Promise<Response | null> {
  if (!isFetchable(url)) {
    return null;
  }
  const response = await fetch(url, {
    headers: { accept: "text/html" },
    redirect: "manual",
    signal,
  });
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location !== null) {
    await response.body?.cancel();
    if (hops >= MAX_REDIRECTS || !URL.canParse(location, url)) {
      return null;
    }
    return await fetchPage(new URL(location, url), signal, hops + 1);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Preview page responded with ${response.status}.`);
  }
  return response;
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
 * Reads chunks from a stream until the page's head has arrived or the byte
 * limit is reached.
 *
 * @param reader - The response body reader.
 * @param decoder - Decodes the bytes as text.
 * @param html - The text read so far.
 * @param bytes - The bytes read so far.
 * @returns The text read.
 */
async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  html: string,
  bytes: number
): Promise<string> {
  if (bytes >= MAX_BYTES || html.includes("</head>")) {
    return html;
  }
  const { done, value } = await reader.read();
  if (done) {
    return html;
  }
  return await readChunks(
    reader,
    decoder,
    html + decoder.decode(value, { stream: true }),
    bytes + value.byteLength
  );
}

/**
 * Reads the start of a response body, up to {@link MAX_BYTES}.
 *
 * @param response - The page response.
 * @returns The decoded text.
 */
async function readHead(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const html = await readChunks(reader, new TextDecoder(), "", 0);
  await reader.cancel();
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
  const response = await fetchPage(
    new URL(pageUrl),
    AbortSignal.timeout(TIMEOUT_MS),
    0
  );
  if (response === null) {
    return null;
  }
  const match = findImageMeta(await readHead(response));
  if (match === undefined) {
    return null;
  }
  const source = match.replaceAll("&amp;", "&");
  if (!URL.canParse(source, response.url)) {
    return null;
  }
  const image = new URL(source, response.url);
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

/**
 * Server function that returns a page's preview image for a browser with
 * access to the chat. Each URL is fetched at most once per server instance,
 * except after a failed fetch, which the next request retries.
 *
 * @returns The image URL, or `null` when the page has none, can't be read, or
 * the browser lacks access.
 */
export const getPreviewImage = createServerFn({ method: "POST" })
  .validator(z.object({ url: z.url() }))
  .handler(async ({ data }): Promise<string | null> => {
    const status = await resolveAccessStatus();
    if (status !== "open" && status !== "authorized") {
      return null;
    }
    const cached = cache.get(data.url);
    if (cached !== undefined) {
      return await cached;
    }
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    const lookup = lookupPreviewImage(data.url);
    cache.set(data.url, lookup);
    return await lookup;
  });
