import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 33 channels answered input requests without a responder field; epoch 34 adds it as optional.
export default defineChannel({
  routes: [
    POST("/answer/:sessionId", async (_request, { attachSession, params }) => {
      await attachSession(params.sessionId!).respond(
        [{ optionId: "approve", requestId: "approval-1" }],
        { auth: null },
      );
      return new Response("ok");
    }),
  ],
});
