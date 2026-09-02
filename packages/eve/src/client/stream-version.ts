import { EVE_STREAM_VERSION_HEADER } from "#protocol/message.js";
import type { MessageStreamVersion } from "#protocol/message-version.js";

const supportedMessageStreamVersions = {
  "24": true,
  "25": true,
} as const satisfies Record<MessageStreamVersion, true>;

/** Reads and validates the schema version declared by a message stream response. */
export function readMessageStreamVersion(headers: Headers): MessageStreamVersion {
  const version = headers.get(EVE_STREAM_VERSION_HEADER);
  if (version !== null && Object.hasOwn(supportedMessageStreamVersions, version)) {
    return version as MessageStreamVersion;
  }

  if (version === null) {
    throw new TypeError(`Missing ${EVE_STREAM_VERSION_HEADER} response header.`);
  }
  throw new TypeError(`Unsupported message stream version: ${version}.`);
}
