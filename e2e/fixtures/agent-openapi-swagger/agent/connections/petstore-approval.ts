import { defineDynamic, defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

import { resolvePetstoreBaseUrl, PETSTORE_SPEC } from "../lib/petstore.js";

export default defineDynamic({
  events: {
    "session.started": () => ({
      "petstore-approval": defineOpenAPIConnection({
        approval: always(),
        baseUrl: resolvePetstoreBaseUrl(),
        description: "Approval-gated local Swagger Petstore API fixture.",
        instanceKey: "agent-openapi-swagger:petstore-approval",
        operations: { allow: ["getInventory"] },
        spec: PETSTORE_SPEC,
      }),
    }),
  },
});
