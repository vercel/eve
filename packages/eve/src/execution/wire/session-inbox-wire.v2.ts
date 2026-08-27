import { z } from "#compiled/zod/index.js";

import type {
  DeliverHookPayload,
  SessionCommand,
  SessionTimeoutHookPayload,
} from "#channel/types.js";
import type { VersionMigration } from "#execution/durable-session-migrations/chain.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
import {
  encodeSessionCommandV1,
  sessionInboxWireV1Schema,
} from "#execution/wire/session-inbox-wire.v1.js";
import { formatValidationError } from "#runtime/validation.js";

const activityWorkIdentitySchema = z
  .object({
    callId: z.string().optional(),
    id: z.string(),
    kind: z.enum(["root-turn", "subagent", "remote-agent", "task"]),
    name: z.string().optional(),
    parentId: z.string().optional(),
    rootSessionId: z.string(),
    rootTurnId: z.string(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
  })
  .strict();
const activityObserverSchema = z
  .object({
    sink: z.object({ url: z.string(), version: z.literal(1) }).strict(),
    workIdentity: activityWorkIdentitySchema.optional(),
  })
  .strict();
const v1 = sessionInboxWireV1Schema.options;
const v1Deliver = v1[0];
const v1Caller = v1Deliver.shape.caller.unwrap();
const version = z.literal(2);

/** Version 2 adds activity observer metadata to delegated callers. */
export const sessionInboxWireV2Schema = z.discriminatedUnion("kind", [
  v1Deliver.extend({
    caller: v1Caller.extend({ activityObserver: activityObserverSchema.optional() }).optional(),
    version,
  }),
  v1[1].extend({ version }),
  v1[2].extend({ version }),
  v1[3].extend({ version }),
  v1[4].extend({ version }),
  v1[5].extend({ version }),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;

export const sessionInboxWireV1Migration: VersionMigration = {
  from: 1,
  migrate(prior) {
    const parsed = sessionInboxWireV1Schema.safeParse(prior);
    if (!parsed.success) {
      throw new SessionInboxWireError(
        `Session inbox payload does not match wire version 1: ${formatValidationError(parsed.error)}`,
      );
    }
    return { ...parsed.data, version: 2 };
  },
  to: 2,
};

/** Builds and validates one complete version-2 wire value. */
export function encodeSessionCommandV2(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): SessionInboxWireV2 {
  const activityObserver = "caller" in command ? command.caller?.activityObserver : undefined;
  const v1Command = withoutActivityObserver(command);
  const v1Wire = encodeSessionCommandV1(v1Command);
  const wire =
    v1Wire.kind === "deliver" && activityObserver !== undefined && v1Wire.caller !== undefined
      ? {
          ...v1Wire,
          caller: { ...v1Wire.caller, activityObserver },
          version: 2 as const,
        }
      : { ...v1Wire, version: 2 as const };
  const parsed = sessionInboxWireV2Schema.safeParse(wire);
  if (!parsed.success) {
    throw new SessionInboxWireError(
      `Produced a session inbox payload that does not match wire version 2: ${formatValidationError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function withoutActivityObserver(
  command: DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload,
): DeliverHookPayload | SessionCommand | SessionTimeoutHookPayload {
  if (!("caller" in command) || command.caller?.activityObserver === undefined) return command;
  const { activityObserver: _activityObserver, ...caller } = command.caller;
  return { ...command, caller };
}
