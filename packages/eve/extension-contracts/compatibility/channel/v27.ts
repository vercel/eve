import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  state: {
    threadId: null as string | null,
    visibility: "unknown" as "private" | "public" | "unknown",
  },
  audience: ({ state }) => state?.visibility ?? "unknown",
  metadata: (state) => ({ threadId: state?.threadId ?? null }),
  routes: [POST("/events", async () => new Response("ok"))],
});
