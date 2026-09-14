import { defineChannel, POST } from "eve/channels";

/** Rejects any non-null scheduled reply except the late remote-agent result. */
export default defineChannel<undefined, void, { id: string }>({
  routes: [POST("/scheduled-remote-sink", async () => new Response("ok"))],
  receive(input, { from }) {
    return from(input.target.id).send(input.message, { auth: input.auth });
  },
  events: {
    "message.completed"(event) {
      if (
        event.finishReason !== "tool-calls" &&
        event.message !== null &&
        !JSON.stringify(event.message).includes("SCHEDULED-REMOTE-FINAL")
      ) {
        throw new Error(`Scheduled remote sink received an unexpected message: ${event.message}`);
      }
    },
  },
});
