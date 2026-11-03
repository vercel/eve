import { defineHook } from "eve/hooks";

import { personal } from "../lib/personal.ts";
import { admitted, readsPersonal, requested, settled } from "../lib/private-context.ts";

export default defineHook({
  events: {
    // A turn's calls run with the credentials of whoever sent its message.
    "delivery.admitted"(event) {
      const principalId = event.data.principal?.id;
      if (principalId === undefined || principalId === personal.get().caller) return;
      personal.update((state) => admitted(state, principalId));
    },
    // Tags ride only on `call.requested`; the call's row in `ctx.view` doesn't carry them.
    "call.requested"(event) {
      const { callId, capability } = event.data;
      if (!readsPersonal(capability)) return;
      personal.update((state) => requested(state, callId, capability.name));
    },
    "call.settled"(event) {
      const { callId, outcome } = event.data;
      if (personal.get().pending[callId] === undefined) return;
      personal.update((state) => settled(state, callId, outcome));
    },
  },
});
