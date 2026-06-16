/**
 * Opaque attachment references: the wire format a channel uses to carry
 * file identity across step boundaries without inlining the bytes.
 *
 * Refs are compact custom-scheme URLs:
 *
 * ```
 * eve-attachment:?v=1&p=<base64url-encoded JSON of { params, size? }>
 * ```
 */

/**
 * Custom URL scheme used by every attachment ref. The trailing colon
 * is part of the scheme per WHATWG URL semantics.
 */
export const ATTACHMENT_REF_SCHEME = "eve-attachment:";

/**
 * Current wire format version. Decoders reject any other value so a
 * future format bump doesn't silently misparse.
 */
export const ATTACHMENT_REF_WIRE_VERSION = "1";

import { toErrorMessage } from "#shared/errors.js";

const VERSION_QUERY_KEY = "v";
const PAYLOAD_QUERY_KEY = "p";

/**
 * Serializable description of one inbound file attachment.
 *
 * `params` is an adapter-defined, JSON-safe object typed by the generic
 * parameter. It identifies the upstream file and must not carry
 * credentials; resolvers read credentials from adapter context or closure.
 *
 * `size` is optional. Populating it when the upstream protocol exposes
 * the byte length up front lets upload-policy size checks run without
 * fetching the bytes.
 */
export interface AttachmentRef<TParams = unknown> {
  readonly params: TParams;
  readonly size?: number;
}

function isValidSize(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Encodes an {@link AttachmentRef} as a URL suitable for use as
 * `FilePart.data`.
 *
 * `TParams` links the encoded payload shape to the channel resolver.
 */
export function encodeAttachmentRef<TParams>(ref: AttachmentRef<TParams>): URL {
  if (ref.size !== undefined && !isValidSize(ref.size)) {
    throw new RangeError(
      `AttachmentRef.size must be a non-negative integer. Received: ${String(ref.size)}.`,
    );
  }

  const payload =
    ref.size === undefined ? { params: ref.params } : { params: ref.params, size: ref.size };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

  const url = new URL(ATTACHMENT_REF_SCHEME);
  url.searchParams.set(VERSION_QUERY_KEY, ATTACHMENT_REF_WIRE_VERSION);
  url.searchParams.set(PAYLOAD_QUERY_KEY, encoded);
  return url;
}

/**
 * Parses an {@link AttachmentRef} back out of a URL.
 */
export function parseAttachmentRef<TParams = unknown>(url: URL): AttachmentRef<TParams> {
  if (url.protocol !== ATTACHMENT_REF_SCHEME) {
    throw new Error(
      `AttachmentRef URL must use scheme "${ATTACHMENT_REF_SCHEME}". Got: "${url.protocol}".`,
    );
  }

  const version = url.searchParams.get(VERSION_QUERY_KEY);
  if (version !== ATTACHMENT_REF_WIRE_VERSION) {
    throw new Error(
      `AttachmentRef wire format version must be "${ATTACHMENT_REF_WIRE_VERSION}". Got: ${
        version === null ? "missing" : JSON.stringify(version)
      }.`,
    );
  }

  const encoded = url.searchParams.get(PAYLOAD_QUERY_KEY);
  if (encoded === null || encoded === "") {
    throw new Error('AttachmentRef URL is missing the required "p" payload query param.');
  }

  let payload: unknown;
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    payload = JSON.parse(json);
  } catch (cause) {
    throw new Error(
      `AttachmentRef payload is not valid base64url-encoded JSON: ${toErrorMessage(cause)}`,
    );
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AttachmentRef payload must decode to a JSON object.");
  }

  const record = payload as Record<string, unknown>;
  if (!("params" in record)) {
    throw new Error('AttachmentRef payload is missing the required "params" field.');
  }

  const params = record.params as TParams;

  if (!("size" in record)) {
    return { params };
  }

  const size = record.size;
  if (typeof size !== "number" || !isValidSize(size)) {
    throw new Error(
      `AttachmentRef payload "size" must be a non-negative integer. Got: ${JSON.stringify(size)}.`,
    );
  }

  return { params, size };
}

/**
 * Cheap runtime check: does this value look like an attachment-ref URL?
 *
 * Accepts `URL` instances with the `eve-attachment:` scheme. Strings
 * are NOT accepted — the staging layer only checks URL-instance
 * `FilePart.data` values, matching the existing `data instanceof URL`
 * branch in `fileDataToBytes`.
 */
export function isAttachmentRefUrl(value: unknown): value is URL {
  return value instanceof URL && value.protocol === ATTACHMENT_REF_SCHEME;
}
