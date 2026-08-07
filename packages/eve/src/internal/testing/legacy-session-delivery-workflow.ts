import { createHook } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload } from "#channel/types.js";

/** Models the continuation consumer shipped before SessionCommand existed. */
export async function legacySessionDeliveryWorkflow(input: {
  readonly token: string;
}): Promise<string> {
  "use workflow";

  const deliveries = createHook<DeliverHookPayload>({ token: input.token });
  for await (const delivery of deliveries) {
    if (delivery.kind !== "deliver") continue;
    const message = delivery.payloads[0]?.payload.message;
    return typeof message === "string" ? message : "";
  }
  return "";
}
