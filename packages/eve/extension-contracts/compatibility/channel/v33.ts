import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [
    POST("/answer/:sessionId", async (_request, { attachSession, params }) => {
      const result = await attachSession(params.sessionId!).respond(
        [{ requestId: "approval-request", text: "approved" }],
        { auth: null },
      );
      return Response.json({ status: result.status });
    }),
  ],
});
