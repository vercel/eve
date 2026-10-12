import { EVE_MESSAGE_STREAM_VERSION, EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";

/** The one stream version this client reads. Sessions don't cross a major version. */
export type MessageStreamVersion = typeof EVE_MESSAGE_STREAM_VERSION;

/** Reads and validates the schema version declared by a message stream response. */
export function readMessageStreamVersion(headers: Headers): MessageStreamVersion {
  const version = headers.get(EVE_STREAM_VERSION_HEADER);
  if (version === EVE_MESSAGE_STREAM_VERSION) return version;
  if (version === null) {
    throw new TypeError(`Missing ${EVE_STREAM_VERSION_HEADER} response header.`);
  }
  throw new TypeError(`Unsupported message stream version: ${version}.`);
}
