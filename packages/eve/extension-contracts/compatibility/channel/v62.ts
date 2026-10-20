import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/messages", async (_request, { from }) => {
      const session = await from("reports").send("Prepare Alice's report.", { auth: null });
      await session.send("Include Bob's notes.", { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
