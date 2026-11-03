import { defineHook } from "eve/hooks";

import extension from "../extension.ts";
import { exposure } from "../lib/exposure.ts";
import { expose, MESSAGE_SOURCE, readsOf, requested, settled } from "../lib/taint.ts";

export default defineHook({
  events: {
    // Tags ride only on `call.requested`; the call's row in `ctx.view` doesn't carry them.
    "call.requested"(event) {
      const { callId, capability } = event.data;
      const reads = readsOf(capability);
      if (reads.length === 0) return;
      exposure.update((state) => requested(state, callId, capability.name, reads));
    },
    "call.settled"(event) {
      const { callId, outcome } = event.data;
      if (exposure.get().pending[callId] === undefined) return;
      exposure.update((state) => settled(state, callId, outcome));
    },
    "delivery.admitted"(event, ctx) {
      if (!extension.config.untrustedMessages) return;
      const principal = event.data.principal;
      if (principal === undefined) return;
      if (principal.id === ctx.session.auth.initiator?.principalId) return;
      exposure.update((state) => expose(state, "untrusted", MESSAGE_SOURCE));
    },
  },
});
