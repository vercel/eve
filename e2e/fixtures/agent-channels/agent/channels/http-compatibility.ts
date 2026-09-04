import { defineChannel, GET, HEAD } from "eve/channels";

export default defineChannel({
  cors: { origin: ["https://channel.example"], methods: ["GET", "HEAD"] },
  routes: [
    GET("/http-compat/params/:value", async (_request, { params }) => Response.json(params)),
    GET("/http-compat/static", async () => new Response("canonical")),
    GET(
      "/http-compat/head",
      async (request) =>
        new Response("get-body", {
          headers: { "x-channel-method": request.method, "x-handler": "GET" },
        }),
    ),
    GET(
      "/http-compat/explicit",
      async () => new Response("get-body", { headers: { "x-handler": "GET" } }),
    ),
    HEAD(
      "/http-compat/explicit",
      async () => new Response(null, { headers: { "x-handler": "HEAD" } }),
    ),
    GET("/http-compat/error", async () => {
      throw new Error("fixture-private-error");
    }),
  ],
});
