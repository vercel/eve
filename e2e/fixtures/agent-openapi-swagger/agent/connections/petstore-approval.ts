import { defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

import { PETSTORE_BASE_URL, PETSTORE_SPEC } from "../lib/petstore.js";

export default defineOpenAPIConnection({
  approval: always(),
  baseUrl: PETSTORE_BASE_URL,
  spec: PETSTORE_SPEC,
  description: "Approval-gated local Swagger Petstore API fixture.",
  operations: { allow: ["getInventory"] },
});
