import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 36 approval.candidate and approval.settled carried no taskId; epoch 37
// adds an optional taskId for approvals proxied from a child task.
export default defineChannel({
  routes: [
    GET("/approvals/:sessionId", async (_request, { attachSession, params }) => {
      const events = await attachSession(params.sessionId!).getEventStream();
      const settled: string[] = [];
      for await (const event of events) {
        if (event.type === "approval.settled") {
          settled.push(`${event.data.requestId}:${event.data.outcome}`);
        }
        if (event.type === "session.completed") break;
      }
      return Response.json({ settled });
    }),
  ],
});
