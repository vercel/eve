import { POST, defineChannel } from "#public/channels/index.js";

export default defineChannel({
  state: { audience: "private" as const },
  metadata(state) {
    return { audience: state.audience };
  },
  routes: [POST("/input", async () => new Response("ok"))],
});
