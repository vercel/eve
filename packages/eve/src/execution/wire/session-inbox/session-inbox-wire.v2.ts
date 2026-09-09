import { z } from "#compiled/zod/index.js";

import { sessionInboxWireV1Schema } from "#execution/wire/session-inbox/session-inbox-wire.v1.js";

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
    payload: v1Deliver.shape.payload.unwrap(),
    version,
  }),
  v1[1].extend({ version }),
  v1[2].extend({ version }),
  v1[3].extend({ version }),
  v1[4].extend({ version }),
  v1[5].extend({ version }),
]);

export type SessionInboxWireV2 = z.infer<typeof sessionInboxWireV2Schema>;
