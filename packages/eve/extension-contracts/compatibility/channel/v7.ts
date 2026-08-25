import { defineChannel, POST } from "#public/channels/index.js";

export default defineChannel({
  routes: [POST("/files", async () => new Response("ok"))],
  async fetchFile(url) {
    return url.startsWith("https://files.example.com/") ? Buffer.from("example") : null;
  },
});
