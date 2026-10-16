import { defineChannel, POST } from "eve/channels";

export default defineChannel({
  state: { author: "" },
  deliver(payload) {
    return { ...payload, message: `${payload.state?.author}: ${payload.message}` };
  },
  routes: [
    POST("/delivery", async (_request, { from }) => {
      const session = await from(crypto.randomUUID()).send(
        "Please acknowledge the meeting notes.",
        { auth: null, state: { author: "Alice" } },
      );
      return Response.json({ sessionId: session.id });
    }),
  ],
});
