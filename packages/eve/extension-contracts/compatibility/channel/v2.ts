import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [POST("/events", async () => new Response("ok"))],
  async receive(input, { from }) {
    const sessionRef =
      typeof input.target.sessionRef === "string" ? input.target.sessionRef : "default";
    return from(sessionRef).send(input.message, { auth: input.auth });
  },
});
