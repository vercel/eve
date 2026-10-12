import type { MessageFilePart, MessagePart, MessageTextPart } from "#shared/message-content.js";

const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Creates an AI SDK `MessageFilePart` whose data is an inline `data:` URL.
 */
export function createDataUrlFilePart(input: {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType: string;
}): MessageFilePart {
  const part: MessageFilePart = {
    data: `data:${input.mediaType};base64,${bytesToBase64(input.bytes)}`,
    mediaType: input.mediaType,
    type: "file",
  };
  return input.filename === undefined || input.filename.length === 0
    ? part
    : { ...part, filename: input.filename };
}

/**
 * Builds one user turn containing text plus an inline file attachment.
 */
export function createTextWithFileContent(input: {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType: string;
  readonly text: string;
}): MessagePart[] {
  const textPart: MessageTextPart = { text: input.text, type: "text" };
  const filePart = createDataUrlFilePart(input);
  return [textPart, filePart];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE);
    binary += String.fromCodePoint(...chunk);
  }

  return btoa(binary);
}
