import { defineChannel, POST, type AudienceInput } from "#public/channels/index.js";

const audience = ({ auth }: AudienceInput<undefined>) =>
  auth?.principalType === "user" ? "private" : "unknown";

export default defineChannel({
  audience,
  routes: [POST("/legacy-audience", async () => new Response("ok"))],
});
