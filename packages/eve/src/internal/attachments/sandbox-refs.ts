/**
 * Sandbox-resident attachment references.
 *
 * Refs are the compact wire format used after inbound attachment bytes
 * have been written into the sandbox:
 *
 * ```
 * eve-sandbox:?path=<urlencoded-resolved-path>&size=<bytes>&type=<mediaType>[&width=&height=][&pages=]
 * ```
 */

import {
  INLINE_IMAGE_MEDIA_TYPES,
  type MediaMetadata,
} from "#internal/attachments/media-metadata.js";

/**
 * Custom URL scheme used by every sandbox-resident attachment ref. The
 * trailing colon is part of the scheme per WHATWG URL semantics.
 */
export const SANDBOX_URL_SCHEME = "eve-sandbox:";

const PATH_QUERY_KEY = "path";
const SIZE_QUERY_KEY = "size";
const TYPE_QUERY_KEY = "type";
const METADATA_QUERY_KEYS = ["width", "height", "pages"] as const;

/**
 * Upper bound, in bytes, on inbound images that hydrate as inline bytes.
 * Larger images reach the model as a text reference to their sandbox path.
 */
const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

/** Providers reject an image wider or taller than this, failing the whole request. */
const INLINE_IMAGE_MAX_SIDE_PX = 8000;

/** Upper bound, in bytes, on inbound PDFs that hydrate as inline bytes. */
const INLINE_PDF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Serializable description of one sandbox-resident file attachment.
 *
 * `path` is the backend-native absolute path returned by
 * {@link SandboxSession.resolvePath}; the {@link MediaMetadata} fields are
 * snapshotted so hydration and token estimates never re-read the file.
 */
export interface SandboxRef extends MediaMetadata {
  readonly path: string;
}

function isValidSize(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Encodes a {@link SandboxRef} as a URL suitable for use as
 * `FilePart.data`.
 */
export function encodeSandboxRef(ref: SandboxRef): URL {
  if (typeof ref.path !== "string" || ref.path.length === 0) {
    throw new RangeError("SandboxRef.path must be a non-empty string.");
  }
  if (!isValidSize(ref.size)) {
    throw new RangeError(
      `SandboxRef.size must be a non-negative integer. Received: ${String(ref.size)}.`,
    );
  }
  if (typeof ref.mediaType !== "string" || ref.mediaType.length === 0) {
    throw new RangeError("SandboxRef.mediaType must be a non-empty string.");
  }

  const url = new URL(SANDBOX_URL_SCHEME);
  url.searchParams.set(PATH_QUERY_KEY, ref.path);
  url.searchParams.set(SIZE_QUERY_KEY, String(ref.size));
  url.searchParams.set(TYPE_QUERY_KEY, ref.mediaType);
  for (const key of METADATA_QUERY_KEYS) {
    const value = ref[key];
    if (value !== undefined && isValidSize(value)) url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Parses a {@link SandboxRef} from its URL form.
 */
export function decodeSandboxRef(value: URL | string): SandboxRef {
  const url = value instanceof URL ? value : new URL(value);

  if (url.protocol !== SANDBOX_URL_SCHEME) {
    throw new Error(
      `SandboxRef URL must use scheme "${SANDBOX_URL_SCHEME}". Got: "${url.protocol}".`,
    );
  }

  const path = url.searchParams.get(PATH_QUERY_KEY);
  if (path === null || path === "") {
    throw new Error('SandboxRef URL is missing the required "path" query param.');
  }

  const sizeRaw = url.searchParams.get(SIZE_QUERY_KEY);
  if (sizeRaw === null || sizeRaw === "") {
    throw new Error('SandboxRef URL is missing the required "size" query param.');
  }
  const size = Number(sizeRaw);
  if (!isValidSize(size)) {
    throw new Error(
      `SandboxRef URL "size" must be a non-negative integer. Got: ${JSON.stringify(sizeRaw)}.`,
    );
  }

  const mediaType = url.searchParams.get(TYPE_QUERY_KEY);
  if (mediaType === null || mediaType === "") {
    throw new Error('SandboxRef URL is missing the required "type" query param.');
  }

  const ref: { -readonly [K in keyof SandboxRef]: SandboxRef[K] } = { mediaType, path, size };
  for (const key of METADATA_QUERY_KEYS) {
    const value = Number(url.searchParams.get(key) ?? Number.NaN);
    if (isValidSize(value) && value > 0) ref[key] = value;
  }
  return ref;
}

/**
 * Whether an attachment ref reaches the model as bytes as well as its label.
 * Only shapes every major provider reads natively qualify: PNG, JPEG, GIF,
 * and WebP images up to 3 MiB and 8000 px per side, and PDFs up to 20 MiB.
 * Staging verifies these media types from the bytes. Pure in the ref, so a
 * message renders the same way on every model call.
 */
export function inlinesSandboxRefAsBytes(ref: SandboxRef): boolean {
  if (INLINE_IMAGE_MEDIA_TYPES.has(ref.mediaType)) {
    return (
      ref.size <= INLINE_IMAGE_MAX_BYTES &&
      (ref.width ?? 0) <= INLINE_IMAGE_MAX_SIDE_PX &&
      (ref.height ?? 0) <= INLINE_IMAGE_MAX_SIDE_PX
    );
  }
  if (ref.mediaType === "application/pdf") return ref.size <= INLINE_PDF_MAX_BYTES;
  return false;
}

/**
 * Cheap runtime check: does this value look like a sandbox-ref URL?
 *
 * Accepts `URL` instances with the `eve-sandbox:` scheme. Strings are
 * NOT accepted — the staging and hydration layers only inspect
 * URL-instance `FilePart.data` values, matching the existing
 * `data instanceof URL` branch in `readFileData`.
 */
export function isSandboxRefUrl(value: unknown): value is URL {
  return value instanceof URL && value.protocol === SANDBOX_URL_SCHEME;
}
