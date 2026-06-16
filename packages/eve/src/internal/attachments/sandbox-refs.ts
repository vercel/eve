/**
 * Sandbox-resident attachment references.
 *
 * Refs are the compact wire format used after inbound attachment bytes
 * have been written into the sandbox:
 *
 * ```
 * eve-sandbox:?path=<urlencoded-resolved-path>&size=<bytes>&type=<mediaType>
 * ```
 */

/**
 * Custom URL scheme used by every sandbox-resident attachment ref. The
 * trailing colon is part of the scheme per WHATWG URL semantics.
 */
export const SANDBOX_URL_SCHEME = "eve-sandbox:";

const PATH_QUERY_KEY = "path";
const SIZE_QUERY_KEY = "size";
const TYPE_QUERY_KEY = "type";

/**
 * Serializable description of one sandbox-resident file attachment.
 *
 * `path` is the backend-native absolute path returned by
 * {@link SandboxSession.resolvePath}; `size` and `mediaType` are
 * snapshotted so hydration can decide whether to inline without
 * re-reading the file.
 */
export interface SandboxRef {
  readonly path: string;
  readonly size: number;
  readonly mediaType: string;
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

  return { mediaType, path, size };
}

/**
 * Cheap runtime check: does this value look like a sandbox-ref URL?
 *
 * Accepts `URL` instances with the `eve-sandbox:` scheme. Strings are
 * NOT accepted — the staging and hydration layers only inspect
 * URL-instance `FilePart.data` values, matching the existing
 * `data instanceof URL` branch in `fileDataToBytes`.
 */
export function isSandboxRefUrl(value: unknown): value is URL {
  return value instanceof URL && value.protocol === SANDBOX_URL_SCHEME;
}
