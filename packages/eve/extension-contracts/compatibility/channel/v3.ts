import { defineChannel, POST } from "#public/definitions/channel.js";

export default defineChannel({
  routes: [POST("/input", async () => new Response("ok"))],
  events: {
    "input.requested"(data) {
      console.info(
        "input requested",
        data.requests.map((request) => request.requestId),
      );
    },
  },
});
