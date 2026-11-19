import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { resolveAccessStatus } from "./access";
import { requestPublicPage } from "./public-page";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 4000;
const MAX_CACHED = 500;

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
    html +
      decoder.decode(value.subarray(0, MAX_BYTES - bytes), { stream: true }),
    bytes + value.byteLength
  );
}

/**
 * Reads the start of a response body, up to {@link MAX_BYTES}.
 *
 * @param response - The page response.
 * @returns The decoded text.
 */
async function readHead(response: IncomingMessage): Promise<string> {
  const reader = Readable.toWeb(response).getReader();
  try {
    return await readChunks(reader, new TextDecoder(), "", 0);
  } finally {
    await reader.cancel();
  }
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
  const response = await requestPublicPage(
    new URL(pageUrl),
    AbortSignal.timeout(TIMEOUT_MS)
  );
  if (response === null) {
    return null;
  }
  const match = findImageMeta(await readHead(response.response));
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
