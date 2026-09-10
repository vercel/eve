import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/message", async (_request, { from }) => {
      const session = await from("shared-thread").send("Hello", {
        auth: null,
        turnPolicy: "queue",
      });
      await session.send("Follow up", { auth: null, turnPolicy: "queue" });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
