// What a person sends: eve's own shape, so the input contract doesn't follow the AI SDK's types.
// It's the subset of the AI SDK's user content eve accepts, so its text and file parts pass as is.

export const MAX_MESSAGE_PARTS = 64;

/** Text a person sends. */
export interface MessageTextPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * A file a person sends. `data` is the file inline, as bytes, base64, or a `data:` URL; or a URL:
 * eve loads URLs through the channel's `fetchFile` or its public HTTPS fallback.
 */
export interface MessageFilePart<
  TData extends Uint8Array | ArrayBuffer | string | URL = Uint8Array | ArrayBuffer | string | URL,
> {
  readonly type: "file";
  readonly mediaType: string;
  readonly filename?: string;
  readonly data: TData;
}

export type MessagePart<TData extends MessageFilePart["data"] = MessageFilePart["data"]> =
  | MessageTextPart
  | MessageFilePart<TData>;

/** What a person sends: text, or text and files. */
export type MessageContent<TData extends MessageFilePart["data"] = MessageFilePart["data"]> =
  | string
  | readonly MessagePart<TData>[];
