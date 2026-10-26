// Epoch 67 of the channel capability: sandbox sessions typed from the AI SDK. Epoch 68 declares
// eve-owned session types with the same methods and adds `writeFiles`, which is additive.
import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/reports", async (_request, { from }) => {
      const { session } = await from("reports").create({
        auth: null,
        history: [{ role: "user", text: "Alice requested a report." }],
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
  events: {
    "turn.completed": async (_event, _channel, ctx) => {
      const sandbox = await ctx.getSandbox();
      await sandbox.writeTextFile({ content: "Report sent to Bob.", path: "reports/status.txt" });
    },
  },
});
