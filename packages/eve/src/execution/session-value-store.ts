// Where a commit's large values go when they cannot travel inline.
//
// The store is the session's own sandbox, under eve's dot-directory, reached through the same
// `eve-sandbox:` reference the attachment pipeline already uses for tool-result bytes. Reusing it
// means a value moved out of a commit is addressed the way every other out-of-line payload in a
// session is, and read back by the same `decodeSandboxRef` + `readBinaryFile` pair.
//
// Without a sandbox — or when the write fails — the value is published as withheld: a reference
// with no `ref`, which the envelope defines as "the value exists but isn't published" and readers
// already render. That is a real loss of detail in the stream, and still far better than the
// alternative it replaces, which was failing the commit and with it the turn.

import { createHash } from "node:crypto";

import type { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { encodeSandboxRef } from "#internal/attachments/sandbox-refs.js";
import { createLogger } from "#internal/logging.js";
import type { StageValue } from "#protocol/session-events/large-values.js";
import type { JsonValue } from "#protocol/session-events/envelope.js";

/**
 * Directory, relative to the workspace root, where eve stores values moved out of a commit. A
 * sibling of `attachments/` under eve's own dot-directory, so it never collides with an agent's
 * files and is obvious when a person opens the sandbox.
 */
const VALUES_ROOT = ".eve/values";

const VALUE_MEDIA_TYPE = "application/json";
const SHA_PREFIX_LENGTH = 16;

const log = createLogger("execution.session-value-store");

/**
 * Stages a commit's large values in the session's sandbox.
 *
 * Content-addressed, so the same value staged twice writes one file: a retried step republishing
 * its commit reuses what the interrupted attempt wrote instead of leaving an orphan behind.
 */
export function createSessionValueStore(ctx: ContextContainer): StageValue {
  let sandbox: Promise<Awaited<ReturnType<NonNullable<typeof access>["open"]>>> | undefined;
  const access = ctx.get(SandboxKey);

  return async (value: JsonValue) => {
    if (access === undefined) {
      log.warn("no sandbox is bound; publishing an oversized session value as withheld");
      return { mediaType: VALUE_MEDIA_TYPE, withheld: true };
    }
    try {
      // Attachments need only the connection, not the skill files queued behind the open.
      sandbox ??= access.open();
      const session = await sandbox;
      if (session === null) {
        log.warn("session sandbox unavailable; publishing an oversized session value as withheld");
        return { mediaType: VALUE_MEDIA_TYPE, withheld: true };
      }
      const content = new TextEncoder().encode(JSON.stringify(value));
      const path = `${VALUES_ROOT}/${sha256Prefix(content)}.json`;
      await session.writeBinaryFile({ content, path });
      return {
        mediaType: VALUE_MEDIA_TYPE,
        ref: encodeSandboxRef({
          mediaType: VALUE_MEDIA_TYPE,
          path: session.resolvePath(path),
          size: content.byteLength,
        }).href,
      };
    } catch (error) {
      // The commit's facts have already happened; refusing to publish them because their payload
      // could not be stored would lose the facts as well as the payload.
      log.warn("sandbox write failed; publishing an oversized session value as withheld", {
        error,
      });
      return { mediaType: VALUE_MEDIA_TYPE, withheld: true };
    }
  };
}

function sha256Prefix(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, SHA_PREFIX_LENGTH);
}
