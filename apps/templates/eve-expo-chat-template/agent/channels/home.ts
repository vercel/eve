import { defineChannel, GET, HEAD } from "eve/channels";

const redirect = async () =>
  new Response(null, {
    status: 302,
    headers: { Location: "/start", "Cache-Control": "no-store" },
  });

export default defineChannel({ routes: [GET("/", redirect), HEAD("/", redirect)] });
