import { z } from "#compiled/zod/index.js";

import { sessionInboxWireV2Schema } from "#execution/wire/session-inbox-wire.v2.js";

const v2 = sessionInboxWireV2Schema.options;
const v2Deliver = v2[0];
const v2DeliveryMetadata = v2Deliver.shape.deliveryMetadata.unwrap().element;
const version = z.literal(3);

/** Version 3 adds the trusted deployment that accepted each channel delivery. */
export const sessionInboxWireV3Schema = z.discriminatedUnion("kind", [
  v2Deliver.extend({
    deliveryMetadata: z
      .array(v2DeliveryMetadata.extend({ acceptedDeploymentId: z.string().optional() }))
      .optional(),
    version,
  }),
  v2[1].extend({ version }),
  v2[2].extend({ version }),
  v2[3].extend({ version }),
  v2[4].extend({ version }),
  v2[5].extend({ version }),
]);

export type SessionInboxWireV3 = z.infer<typeof sessionInboxWireV3Schema>;
