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

const v6 = sessionInboxWireV6Schema.options;
const v6Deliver = v6[0];
const v6Caller = v6Deliver.shape.caller.unwrap();
const v6ActivityObserver = v6Caller.shape.activityObserver.unwrap();
const v6WorkIdentity = v6ActivityObserver.shape.workIdentity.unwrap();
const VERSION = 7;
const version = z.literal(VERSION);

/** Version 7 adds optional presentation labels to delegated activity work. */
export const sessionInboxWireV7Schema = z.discriminatedUnion("kind", [
  v6Deliver.extend({
    caller: v6Caller
      .extend({
        activityObserver: v6ActivityObserver
          .extend({
            workIdentity: v6WorkIdentity.extend({ label: z.string().optional() }).optional(),
          })
          .optional(),
      })
      .optional(),
    version,
  }),
  v6[1].extend({ version }),
  v6[2].extend({ version }),
  v6[3].extend({ version }),
  v6[4].extend({ version }),
  v6[5].extend({ version }),
]);

export type SessionInboxWireV7 = z.infer<typeof sessionInboxWireV7Schema>;

/** Builds and validates one complete version-7 wire value. */
export function encodeSessionCommandV7(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV7 {
  const label = readActivityLabel(command);
  const encoded = encodeSessionCommandV6(withoutActivityLabel(command));
  const value =
    label === undefined || encoded.kind !== "deliver" || encoded.caller === undefined
      ? { ...encoded, version: VERSION }
      : {
          ...encoded,
          caller: {
            ...encoded.caller,
            activityObserver: {
              ...encoded.caller.activityObserver!,
              workIdentity: { ...encoded.caller.activityObserver!.workIdentity!, label },
            },
          },
          version: VERSION,
        };
  const parsed = sessionInboxWireV7Schema.safeParse(value);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version ${VERSION}: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function readActivityLabel(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): string | undefined {
  return command.kind === "send" || command.kind === "deliver"
    ? command.caller?.activityObserver?.workIdentity?.label
    : undefined;
}

function withoutActivityLabel(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload {
  if (
    (command.kind !== "send" && command.kind !== "deliver") ||
    command.caller?.activityObserver?.workIdentity?.label === undefined
  )
    return command;
  const { label: _label, ...workIdentity } = command.caller.activityObserver.workIdentity;
  return {
    ...command,
    caller: {
      ...command.caller,
      activityObserver: { ...command.caller.activityObserver, workIdentity },
    },
  };
}
