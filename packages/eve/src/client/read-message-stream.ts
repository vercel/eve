import { readNdjsonStream } from "#client/ndjson.js";
import { readMessageStreamVersion } from "#client/stream-version.js";

/** Decode a custom-route response using the same version contract as ClientSession. */
export async function* readMessageStream(
  response: Response,
  options: {
    readonly signal?: AbortSignal;
    readonly onLeaseEnded?: () => void;
  } = {},
) {
  try {
    if (!response.ok) throw new Error(`Session stream failed (${response.status}).`);
    const streamVersion = readMessageStreamVersion(response.headers);
    if (!response.body) throw new Error("The session stream is empty.");
    yield* readNdjsonStream(response.body, {
      ...options,
      streamVersion,
      controlVersion: "1",
      idleTimeoutMs: 30_000,
      maxRecordChars: 8 * 1024 * 1024,
    });
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
