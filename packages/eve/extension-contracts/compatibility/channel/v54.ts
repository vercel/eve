import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 54 had no `history` option or `history.imported` event; epoch 55 adds both, which is additive.
export default defineChannel({
  routes: [POST("/report", async () => new Response("ok"))],
  state: { reply: "" },
  context: (state) => state,
  events: {
    "message.completed"({ message }, channel, ctx) {
      channel.reply = `${ctx.session.id}: ${message}`;
    },
  },
});
