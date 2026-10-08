import { defineChannel, POST } from "eve/channels";
import { recordCollectionDelivery } from "../lib/collection-occurrences";

export default defineChannel<
  { scheduleName: string },
  { scheduleName: string },
  { scheduleName: string }
>({
  routes: [POST("/outbox", async () => new Response(null, { status: 405 }))],
  state: { scheduleName: "" },
  context: (state) => ({ scheduleName: state.scheduleName }),
  async receive(input, { from }) {
    return await from(input.target.scheduleName).send(input.message, {
      auth: input.auth,
      state: { scheduleName: input.target.scheduleName },
    });
  },
  events: {
    "message.completed": ({ message }, channel) =>
      recordCollectionDelivery(channel.scheduleName, message),
  },
});
