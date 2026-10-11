import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 58 `fetchFile` resolvers that read only `state` from their context remain supported.
export default defineChannel({
  async fetchFile(url, context) {
    const token = context?.state.token;
    if (typeof token !== "string" || !url.startsWith("https://files.example.com/")) return null;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    return Buffer.from(await response.arrayBuffer());
  },
  routes: [POST("/files", async () => new Response("ok"))],
});
