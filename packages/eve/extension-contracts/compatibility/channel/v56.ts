import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 56 reads session streams from a start index without a follow option.
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
