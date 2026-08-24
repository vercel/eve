import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [GET("/", async () => new Response("shadowed route"))],
});
