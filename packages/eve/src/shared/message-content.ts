// What a person sends: eve's own shape, so the input contract doesn't follow the AI SDK's types.
// It's the subset of the AI SDK's user content eve accepts, so its text and file parts pass as is.

/** Text a person sends. */
export interface MessageTextPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * A file a person sends. `data` is the file inline, as bytes, base64, or a `data:` URL; or a URL:
 * one the model provider can fetch itself, or one only the channel's `fetchFile` reads.
 */
export interface MessageFilePart {
  readonly type: "file";
  readonly mediaType: string;
  readonly filename?: string;
  readonly data: Uint8Array | ArrayBuffer | string | URL;
}

export type MessagePart = MessageTextPart | MessageFilePart;

/** What a person sends: text, or text and files. */
export type MessageContent = string | readonly MessagePart[];
