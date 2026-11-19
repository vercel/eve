import {
  INLINE_IMAGE_MEDIA_TYPES,
  type MediaMetadata,
} from "#internal/attachments/media-metadata.js";

export const SANDBOX_URL_SCHEME = "eve-sandbox:";

const PATH_QUERY_KEY = "path";
const SIZE_QUERY_KEY = "size";
const TYPE_QUERY_KEY = "type";
const METADATA_QUERY_KEYS = ["width", "height", "pages"] as const;

const INLINE_IMAGE_MAX_BYTES = 3 * 1024 * 1024;

const INLINE_IMAGE_MAX_SIDE_PX = 8000;

const INLINE_PDF_MAX_BYTES = 20 * 1024 * 1024;

export interface SandboxRef extends MediaMetadata {
  readonly path: string;
}

function isValidSize(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

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

export function isSandboxRefUrl(value: unknown): value is URL {
  return value instanceof URL && value.protocol === SANDBOX_URL_SCHEME;
}
