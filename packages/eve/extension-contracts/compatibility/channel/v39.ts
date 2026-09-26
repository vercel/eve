import { defineChannel, POST } from "#public/channels/index.js";

const replies: string[] = [];

export default defineChannel({
  routes: [
    POST("/messages/:threadId", async (request, { from, params }) => {
      const body = (await request.json()) as { message: string };
      await from(params.threadId!).send(body.message, { auth: null });
      return new Response(null, { status: 202 });
    }),
  ],
  events: {
    "message.completed"(data) {
      if (data.finishReason === "stop") replies.push(data.message);
    },
    "session.waiting"(data) {
      if (data.turnId !== undefined) replies.push(`waiting on ${data.turnId}`);
    },
  },
});
