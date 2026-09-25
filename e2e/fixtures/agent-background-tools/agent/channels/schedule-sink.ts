import { defineChannel, POST } from "eve/channels";

/**
 * Delivery target for the `scheduled-export` handler schedule.
 *
 * The only user-facing message this channel may ever receive is the settled
 * report; the launching turn and the pending update wake must stay silent.
 */
export default defineChannel<undefined, void, { id: string }>({
  routes: [POST("/schedule-sink", async () => new Response("ok"))],
  receive(input, { from }) {
    return from(input.target.id).send(input.message, {
      auth: input.auth,
    });
  },
  events: {
    "message.completed"(event) {
      if (
        event.finishReason !== "tool-calls" &&
        event.message !== null &&
        !JSON.stringify(event.message).includes("SCHEDULED-EXPORT-DONE")
      ) {
        throw new Error(`Schedule sink received an unexpected message: ${event.message}`);
      }
    },
  },
});
