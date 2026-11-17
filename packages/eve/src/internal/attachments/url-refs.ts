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

const INTERNAL_REF_SCHEMES = [EVE_URL_SCHEME, SANDBOX_URL_SCHEME, CHAT_SDK_FILE_PROTOCOL];

export function hasInternalRefScheme(data: string): boolean {
  const protocol = /^\s*([a-z][a-z\d+.-]*:)/i.exec(data)?.[1]?.toLowerCase();
  return protocol !== undefined && INTERNAL_REF_SCHEMES.includes(protocol);
}
