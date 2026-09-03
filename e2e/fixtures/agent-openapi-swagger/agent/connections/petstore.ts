import { defineOpenAPIConnection } from "eve/connections";

import { PETSTORE_BASE_URL, PETSTORE_SPEC } from "../lib/petstore.js";

export default defineOpenAPIConnection({
  baseUrl: PETSTORE_BASE_URL,
  spec: PETSTORE_SPEC,
  description: "Local Swagger Petstore API fixture.",
  operations: { allow: ["getInventory"] },
});
