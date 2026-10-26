import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/reports", async (_request, { from }) => {
      const { session } = await from("reports").create({
        auth: null,
        history: [{ role: "user", text: "Alice requested a report." }],
      });
      await session.send("Include Bob's notes.", { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
