import { defineChannel, POST } from "eve/channels";

interface StartRequestBody {
  readonly message?: string;
  readonly threadId?: string;
}

export default defineChannel({
  routes: [
    POST("/workflow-sandbox/start", async (request, { from }) => {
      const input = (await request.json().catch(() => ({}))) as StartRequestBody;
      const threadId = input.threadId?.trim() || crypto.randomUUID();
      const message =
        input.message?.trim() || "Call sandbox_workflow exactly once and return its result.";
      const session = await from(`workflow-sandbox:${threadId}`).send(message, {
        auth: {
          attributes: {},
          authenticator: "workflow-sandbox-smoke",
          principalId: "workflow-sandbox-smoke",
          principalType: "service",
        },
      });

      return Response.json({ sessionId: session.id });
    }),
  ],
});
