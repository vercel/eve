import { defineChannel, GET } from "eve/channels";

import { PETSTORE_SPEC } from "../../petstore";

// A fixture-owned OpenAPI service: eve fetches the spec and calls the operation over HTTP.
export default defineChannel({
  routes: [
    GET("/fixture-petstore/swagger", async () => Response.json(PETSTORE_SPEC)),
    GET("/fixture-petstore/store/inventory", async () =>
      Response.json({ available: 7, pending: 2, sold: 3 }),
    ),
  ],
});
