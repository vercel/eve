import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 57 callbacks that do not inspect a replacement predecessor remain supported.
export default defineChannel({
  routes: [
    GET("/threads/:threadId/events", async (_request, { from, params }) => {
      const session = await from(params.threadId!).send("Read the thread.", { auth: null });
      const events = await session.getEventStream({ startIndex: 0 });
      await events.cancel();
      return new Response("ok");
    }),
  ],
});
