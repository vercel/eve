import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 69 handoffs had no `history`; epoch 70 adds it, which is additive.
export default defineChannel({
  routes: [
    POST("/handoff", async (_req, ctx) => {
      await ctx.from("handoff").send("Continue.", { auth: null });
      return new Response("ok");
    }),
  ],
  receive(input, { from }) {
    return from(`handoff:${String(input.target.ref)}`).send(input.message, { auth: input.auth });
  },
});
