import type { FilePart, TextPart, UserContent } from "ai";

import type { LinearFetch } from "#public/channels/linear/api.js";
import {
  resolveLinearAccessToken,
  type LinearChannelCredentials,
} from "#public/channels/linear/auth.js";

const LINEAR_UPLOAD_ORIGIN = "https://uploads.linear.app";
// Linear writes an uploaded image as `![name](url)` and any other uploaded file as `[name](url)`.
const MARKDOWN_UPLOAD_PATTERN =
  /(!?)\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)\r\n]*\)))?\s*\)/gu;

/** One trusted Linear upload referenced by markdown image or link syntax. */
interface LinearUploadReference {
  readonly end: number;
  /** Whether markdown embeds it as an image, so only image bytes are accepted for it. */
  readonly image: boolean;
  readonly label: string;
  readonly start: number;
  readonly url: URL;
}

/** Extracts markdown images and links that target Linear's exact upload origin. */
export function extractLinearUploadReferences(markdown: string): readonly LinearUploadReference[] {
  const references: LinearUploadReference[] = [];
  for (const match of markdown.matchAll(MARKDOWN_UPLOAD_PATTERN)) {
    const href = match[3] ?? match[4];
    const start = match.index;
    if (href === undefined || start === undefined) continue;

    const url = parseLinearUploadUrl(href);
    if (url === null) continue;

    references.push({
      end: start + match[0].length,
      image: match[1] === "!",
      label: match[2] ?? "",
      start,
      url,
    });
  }
  return references;
}

/** Adds authenticated Linear uploads, images and other files, to otherwise text-only inbound content. */
export async function attachLinearInboundUploads(input: {
  readonly content: UserContent;
  readonly credentials?: LinearChannelCredentials;
  readonly fetch?: LinearFetch;
}): Promise<UserContent> {
  if (typeof input.content !== "string") return input.content;

  const references = extractLinearUploadReferences(input.content);
  if (references.length === 0) return input.content;

  let token: string;
  try {
    token = await resolveLinearAccessToken(input.credentials?.accessToken);
  } catch {
    return input.content;
  }

  const fetchUpload = input.fetch ?? fetch;
  const files = await Promise.all(
    references.map((reference) => fetchLinearUpload(reference, token, fetchUpload)),
  );
  if (files.every((file) => file === null)) return input.content;

  return buildLinearUploadContent(input.content, references, files);
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

async function fetchLinearUpload(
  reference: LinearUploadReference,
  token: string,
  fetchUpload: LinearFetch,
): Promise<FilePart | null> {
  if (parseLinearUploadUrl(reference.url.href) === null) return null;

  try {
    const response = await fetchUpload(reference.url.href, {
      credentials: "omit",
      headers: {
        accept: reference.image ? "image/*" : "*/*",
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });
    if (!response.ok) return null;

    const mediaType = readMediaType(response.headers.get("content-type"), reference.image);
    if (mediaType === null) return null;

    const file: FilePart = {
      data: Buffer.from(await response.arrayBuffer()),
      mediaType,
      type: "file",
    };
    if (!reference.image && reference.label.length > 0) file.filename = reference.label;
    return file;
  } catch {
    return null;
  }
}

function readMediaType(contentType: string | null, image: boolean): string | null {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (image) {
    return mediaType?.startsWith("image/") === true && mediaType.length > "image/".length
      ? mediaType
      : null;
  }
  // An HTML answer is a sign-in or error page, not the uploaded file.
  if (mediaType === "text/html") return null;
  return mediaType === undefined || mediaType.length === 0 ? "application/octet-stream" : mediaType;
}

function buildLinearUploadContent(
  markdown: string,
  references: readonly LinearUploadReference[],
  files: readonly (FilePart | null)[],
): UserContent {
  let cursor = 0;
  let text = "";
  const attached: FilePart[] = [];

  for (const [index, reference] of references.entries()) {
    const file = files[index];
    if (file === null || file === undefined) continue;

    text += markdown.slice(cursor, reference.start);
    text += reference.label;
    cursor = reference.end;
    attached.push(file);
  }
  text += markdown.slice(cursor);

  if (text.trim().length === 0) return attached;
  const textPart: TextPart = { text, type: "text" };
  return [textPart, ...attached];
}
