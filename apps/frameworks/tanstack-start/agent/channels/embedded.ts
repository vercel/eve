import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [GET("/eve-marker", () => new Response("tanstack-start-eve"))],
});
