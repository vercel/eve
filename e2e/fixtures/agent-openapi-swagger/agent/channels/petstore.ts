import { defineChannel, GET } from "eve/channels";

export default defineChannel({
  routes: [
    GET("/petstore/inventory", async () =>
      Response.json({
        available: 42,
        pending: 3,
        sold: 7,
      }),
    ),
  ],
});
