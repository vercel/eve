import type { FilePart, TextPart, UserContent } from "ai";

const BASE64_CHUNK_SIZE = 0x8000;

/**
 * Creates an AI SDK `FilePart` whose data is an inline `data:` URL.
 */
export function createDataUrlFilePart(input: {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType: string;
}): FilePart {
  const part: FilePart = {
    data: `data:${input.mediaType};base64,${bytesToBase64(input.bytes)}`,
    mediaType: input.mediaType,
    type: "file",
  };

  if (input.filename !== undefined && input.filename.length > 0) {
    part.filename = input.filename;
  }

  return part;
}

/**
 * Builds one user turn containing text plus an inline file attachment.
 */
export function createTextWithFileContent(input: {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly mediaType: string;
  readonly text: string;
}): UserContent {
  const textPart: TextPart = { text: input.text, type: "text" };
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
