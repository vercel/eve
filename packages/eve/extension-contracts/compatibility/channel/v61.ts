import { GET, POST, defineChannel } from "#public/channels/index.js";

// Epoch 62 changes types a channel reaches through the session context, as dynamic values and
// hooks move to select, record, render, and run. A channel's routes don't change, so they keep
// working.
export default defineChannel({
  routes: [
    GET("/status", async () => new Response("ok")),
    POST("/inbound", async (request) => {
      const body = (await request.json()) as { readonly text?: string };
      return Response.json({ received: body.text ?? "" });
    }),
  ],
});
