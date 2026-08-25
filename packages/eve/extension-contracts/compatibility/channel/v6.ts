import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  state: { threadId: null as string | null },
  metadata(state) {
    return { threadId: state.threadId };
  },
  routes: [
    POST("/input", async (_request, { from }) => {
      await from("thread-1").respond([{ optionId: "approve", requestId: "approval-1" }], {
        auth: null,
      });
      return new Response("ok");
    }),
  ],
  turnPolicy: "queue",
});
