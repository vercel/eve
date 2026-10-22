import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 65 tool content parts carried base64 file data only; epoch 66 adds file URLs, which is additive.
export default defineChannel({
  routes: [
    POST("/reports", async (_request, { from }) => {
      const { session } = await from("reports").create({ auth: null });
      await session.send("Summarize the attached screenshot.", { auth: null });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
