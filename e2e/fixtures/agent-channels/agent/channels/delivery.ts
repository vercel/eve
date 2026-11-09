import { defineChannel, POST } from "eve/channels";

export default defineChannel<{ author: string }>({
  state: { author: "" },
  deliver(payload) {
    return { ...payload, message: `${payload.state?.author}: ${payload.message}` };
  },
  routes: [
    POST<{ author: string }>("/delivery", async (_request, { from }) => {
      const session = await from(crypto.randomUUID()).send(
        "Please acknowledge the meeting notes.",
        { auth: null, state: { author: "Alice" } },
      );
      return Response.json({ sessionId: session.sessionId });
    }),
  ],
});
