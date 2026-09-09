import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  encodeSessionCommandV6,
  sessionInboxWireV6Schema,
} from "#execution/wire/session-inbox-wire.v6.js";
import { formatValidationError } from "#runtime/validation.js";

const VERSION = 7;
const version = z.literal(VERSION);

/** Version 7 adds acknowledged, no-model session history append. */
const v6 = sessionInboxWireV6Schema.options;

export const sessionInboxWireV7Schema = z.discriminatedUnion("kind", [
  v6[0].extend({ version }),
  v6[1].extend({ version }),
  v6[2].extend({ version }),
  v6[3].extend({ version }),
  v6[4].extend({ version }),
  v6[5].extend({ version }),
  z
    .object({
      kind: z.literal("append-history"),
      messages: z.array(z.unknown()),
      operationId: z.string(),
      replyTo: z.string(),
      version,
    })
    .strict(),
]);

export type SessionInboxWireV7 = z.infer<typeof sessionInboxWireV7Schema>;

export function encodeSessionCommandV7(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV7 {
  const value =
    command.kind === "append-history"
      ? { ...command, version: VERSION }
      : { ...encodeSessionCommandV6(command), version: VERSION };
  const parsed = sessionInboxWireV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}
