import { isReservedPath, RESERVED_PATH_ERROR } from "./reserved-paths.js";

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";
const ORIGINAL_PATH = /^https:\/\/[^/?#]+([^?#]*)/i;

/** Error returned for a URL outside the Vercel Blob HTTPS surface. */
export const NOT_BLOB_URL_ERROR = `Only Vercel Blob URLs (https://*${BLOB_HOST_SUFFIX}/...) are accepted.`;

/** The checked SDK address, or the error to return without contacting storage. */
export type BlobUrlCheck =
  | { readonly error: string; readonly ok: false }
  | { readonly ok: true; readonly url: string };

/**
 * Check a model-supplied Blob URL before passing it to the SDK.
 *
 * @remarks
 * Requires HTTPS, a Vercel Blob host, the default port, and no credentials. Checks the
 * original path before URL parsing can resolve traversal or backslashes, then checks the
 * parsed path too. The path guard decodes once and fails closed on ambiguous encodings.
 * Returns the serialized URL so the SDK requests exactly the address that was checked.
 *
 * @param input - The model-supplied URL.
 * @returns The checked URL or a validation error.
 */
export const checkBlobUrl = (input: string): BlobUrlCheck => {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { error: NOT_BLOB_URL_ERROR, ok: false };
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.endsWith(BLOB_HOST_SUFFIX) ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return { error: NOT_BLOB_URL_ERROR, ok: false };
  }
  const originalPath = ORIGINAL_PATH.exec(input.trim())?.[1];
  if (
    originalPath === undefined ||
    input.includes("\\") ||
    Array.from(input.trim()).some((char) => {
      const code = char.charCodeAt(0);
      return code <= 32 || code === 127;
    }) ||
    isReservedPath(originalPath) ||
    isReservedPath(parsed.pathname)
  ) {
    return { error: RESERVED_PATH_ERROR, ok: false };
  }
  return { ok: true, url: parsed.href };
};
