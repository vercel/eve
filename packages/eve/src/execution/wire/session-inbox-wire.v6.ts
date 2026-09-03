import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  encodeSessionCommandV5,
  sessionInboxWireV5Schema,
} from "#execution/wire/session-inbox-wire.v5.js";
import { formatValidationError } from "#runtime/validation.js";

const v5 = sessionInboxWireV5Schema.options;
const v5Cancel = v5[5];
const VERSION = 6;
const version = z.literal(VERSION);

/** Version 6 adds session-owned task cancellation to the cancel command. */
export const sessionInboxWireV6Schema = z.discriminatedUnion("kind", [
  v5[0].extend({ version }),
  v5[1].extend({ version }),
  v5[2].extend({ version }),
  v5[3].extend({ version }),
  v5[4].extend({ version }),
  v5Cancel.extend({ tasks: z.boolean().optional(), version }),
]);

export type SessionInboxWireV6 = z.infer<typeof sessionInboxWireV6Schema>;

/** Builds and validates one complete version-6 wire value. */
export function encodeSessionCommandV6(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV6 {
  const v5Command = withoutOwnedTaskCancellation(command);
  const value: Record<string, unknown> = {
    ...encodeSessionCommandV5(v5Command),
    version: VERSION,
  };
  if (command.kind === "cancel") value.tasks = command.tasks;
  const parsed = sessionInboxWireV6Schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function withoutOwnedTaskCancellation(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload {
  if (command.kind !== "cancel" || command.tasks === undefined) return command;
  const { tasks: _tasks, ...v5 } = command;
  return v5;
}
