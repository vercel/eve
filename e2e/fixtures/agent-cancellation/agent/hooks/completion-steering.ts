import { setTimeout } from "node:timers/promises";
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "message.received"(event) {
      if (
        typeof event.data.message === "string" &&
        event.data.message.includes("Alice is reviewing the 2026 report.")
      ) {
        // Hold the first model step open while the eval submits Alice's correction.
        await setTimeout(5_000);
      }
    },
  },
});
