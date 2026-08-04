import { defineChannel, POST } from "eve/channels";

export default defineChannel<undefined, void, { id: string }>({
  routes: [POST("/quiet-sink", async () => new Response("ok"))],
  receive(input, { channelAddress }) {
    return channelAddress(input.target.id).send(input.message, {
      auth: input.auth,
    });
  },
  events: {
    "message.completed"(event) {
      if (event.finishReason !== "tool-calls" && event.message !== null) {
        throw new Error(`Quiet sink received an unexpected message: ${event.message}`);
      }
    },
  },
});
