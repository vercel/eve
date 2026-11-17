import type { Attachment } from "#compiled/chat/index.js";

export const CHAT_SDK_FILE_PROTOCOL = "chat-sdk-file:";

export interface ChatSdkFileRef {
  readonly adapter: string;
  readonly attachment: Pick<
    Attachment,
    "fetchMetadata" | "mimeType" | "name" | "size" | "type" | "url"
  >;
}

export function encodeChatSdkFileRef(ref: ChatSdkFileRef): URL {
  const { fetchMetadata, mimeType, name, size, type, url } = ref.attachment;
  const payload = {
    adapter: ref.adapter,
    attachment: { fetchMetadata, mimeType, name, size, type, url },
  };
  const encoded = new URL(CHAT_SDK_FILE_PROTOCOL);
  encoded.searchParams.set("p", Buffer.from(JSON.stringify(payload)).toString("base64url"));
  return encoded;
}

export function parseChatSdkFileRef(url: URL): ChatSdkFileRef | null {
  if (url.protocol !== CHAT_SDK_FILE_PROTOCOL) return null;
  const encoded = url.searchParams.get("p");
  if (encoded === null) return null;
  try {
    const ref = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ChatSdkFileRef;
    return typeof ref.adapter === "string" && typeof ref.attachment === "object" ? ref : null;
  } catch {
    return null;
  }
}
