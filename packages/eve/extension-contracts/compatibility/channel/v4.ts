import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/input", async (_request, { attachSession, from }) => {
      const inputResponses = [{ optionId: "approve", requestId: "approval-1" }];
      await from("thread-1").respond(inputResponses, { auth: null });
      await attachSession("session-1").respond(inputResponses, { auth: null });
      return new Response("ok");
    }),
  ],
});
