import { defineChannel, POST } from "#public/channels/index.js";

// Retained channel epoch 66: existing session authoring works with proactive preparation.
export default defineChannel({
  routes: [
    POST("/reports", async (_request, { from }) => {
      const { session } = await from("reports").create({ auth: null });
      await session.send("Summarize the attached screenshot.", { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
