import type { FilePart, TextPart, UserContent } from "ai";

import type { LinearFetch } from "#public/channels/linear/api.js";
import {
  resolveLinearAccessToken,
  type LinearChannelCredentials,
} from "#public/channels/linear/auth.js";

const LINEAR_UPLOAD_ORIGIN = "https://uploads.linear.app";
const MARKDOWN_IMAGE_PATTERN =
  /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\)/gu;

/** One trusted Linear upload referenced by markdown image syntax. */
export interface LinearUploadImageReference {
  readonly altText: string;
  readonly end: number;
  readonly start: number;
  readonly url: URL;
}

/** Extracts markdown image references that target Linear's exact upload origin. */
export function extractLinearUploadImageReferences(
  markdown: string,
): readonly LinearUploadImageReference[] {
  const references: LinearUploadImageReference[] = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const href = match[2] ?? match[3];
    const start = match.index;
    if (href === undefined || start === undefined) continue;

    const url = parseLinearUploadUrl(href);
    if (url === null) continue;

    references.push({
      altText: match[1] ?? "",
      end: start + match[0].length,
      start,
      url,
    });
  }
  return references;
}

/** Adds authenticated Linear upload images to otherwise text-only inbound content. */
export async function attachLinearInboundImages(input: {
  readonly content: UserContent;
  readonly credentials?: LinearChannelCredentials;
  readonly fetch?: LinearFetch;
}): Promise<UserContent> {
  if (typeof input.content !== "string") return input.content;

  const references = extractLinearUploadImageReferences(input.content);
  if (references.length === 0) return input.content;

  let token: string;
  try {
    token = await resolveLinearAccessToken(input.credentials?.accessToken);
  } catch {
    return input.content;
  }

  const fetchImage = input.fetch ?? fetch;
  const files = await Promise.all(
    references.map((reference) => fetchLinearUploadImage(reference.url, token, fetchImage)),
  );
  if (files.every((file) => file === null)) return input.content;

  return buildLinearImageContent(input.content, references, files);
}

function parseLinearUploadUrl(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== LINEAR_UPLOAD_ORIGIN || url.username !== "" || url.password !== "") {
    return null;
  }
  return url;
}

async function fetchLinearUploadImage(
  url: URL,
  token: string,
  fetchImage: LinearFetch,
): Promise<FilePart | null> {
  if (parseLinearUploadUrl(url.href) === null) return null;

  try {
    const response = await fetchImage(url.href, {
      credentials: "omit",
      headers: {
        accept: "image/*",
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });
    if (!response.ok) return null;

    const mediaType = readImageMediaType(response.headers.get("content-type"));
    if (mediaType === null) return null;

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mediaType,
      type: "file",
    };
  } catch {
    return null;
  }
}

function readImageMediaType(contentType: string | null): string | null {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType?.startsWith("image/") === true && mediaType.length > "image/".length
    ? mediaType
    : null;
}

function buildLinearImageContent(
  markdown: string,
  references: readonly LinearUploadImageReference[],
  files: readonly (FilePart | null)[],
): UserContent {
  let cursor = 0;
  let text = "";
  const attached: FilePart[] = [];

  for (const [index, reference] of references.entries()) {
    const file = files[index];
    if (file === null || file === undefined) continue;

    text += markdown.slice(cursor, reference.start);
    text += reference.altText;
    cursor = reference.end;
    attached.push(file);
  }
  text += markdown.slice(cursor);

  if (text.trim().length === 0) return attached;
  const textPart: TextPart = { text, type: "text" };
  return [textPart, ...attached];
}
