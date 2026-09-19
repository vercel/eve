import { defineChannel, POST } from "eve/channels";

export default defineChannel<undefined, void, { id: string }>({
  routes: [POST("/scheduled-reports", async () => new Response("ok"))],
  receive(input, { from }) {
    return from(input.target.id).send(input.message, { auth: input.auth });
  },
});
