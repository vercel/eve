import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [
    GET(
      "/",
      async () =>
        new Response("canonical application home", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    ),
  ],
});
