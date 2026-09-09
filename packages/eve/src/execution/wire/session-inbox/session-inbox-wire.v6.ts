import { z } from "#compiled/zod/index.js";

import { sessionInboxWireV5Schema } from "#execution/wire/session-inbox/session-inbox-wire.v5.js";

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
