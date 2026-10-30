/**
 * Custom URL scheme for serializing `URL` objects in `FilePart.data`
 * across the queue boundary.
 *
 * Route handlers place `new URL("https://...")` on `FilePart.data`.
 * Before the message crosses the queue, `send()` rewrites these as
 * `eve-url:https://...` strings. After the queue, the staging pipeline
 * reconstitutes them back to `URL` objects so `instanceof URL` checks
 * work reliably.
 */

import { SANDBOX_URL_SCHEME } from "#internal/attachments/sandbox-refs.js";
import { CHAT_SDK_FILE_PROTOCOL } from "#public/channels/chat-sdk/attachment-refs.js";

const EVE_URL_SCHEME = "eve-url:";

export function serializeUrlFilePart(url: URL): string {
  return `${EVE_URL_SCHEME}${url.href}`;
}

export function isSerializedUrlFilePart(data: unknown): data is string {
  return typeof data === "string" && data.startsWith(EVE_URL_SCHEME);
}

export function deserializeUrlFilePart(data: string): URL {
  return new URL(data.slice(EVE_URL_SCHEME.length));
}

/**
 * Framework-internal `FilePart.data` ref schemes, including adapter download refs.
 * eve produces these during its own serialization and staging; an inbound
 * channel payload must never carry one. These refs identify pre-authorized
 * sandbox files or adapter downloads; inbound values must not invoke those
 * capabilities.
 */
const INTERNAL_REF_SCHEMES = [EVE_URL_SCHEME, SANDBOX_URL_SCHEME, CHAT_SDK_FILE_PROTOCOL];

/**
 * Whether a `FilePart.data` string carries a framework-internal ref scheme.
 */
export function hasInternalRefScheme(data: string): boolean {
  // Consumers recognize prefixes even when the rest of the URL is malformed.
  const protocol = /^\s*([a-z][a-z\d+.-]*:)/i.exec(data)?.[1]?.toLowerCase();
  return protocol !== undefined && INTERNAL_REF_SCHEMES.includes(protocol);
}
