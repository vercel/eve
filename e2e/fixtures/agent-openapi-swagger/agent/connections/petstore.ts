import { defineDynamic, defineOpenAPIConnection } from "eve/connections";

import { resolvePetstoreBaseUrl, PETSTORE_SPEC } from "../lib/petstore.js";

export default defineDynamic({
  events: {
    "session.started": () => ({
      petstore: defineOpenAPIConnection({
        baseUrl: resolvePetstoreBaseUrl(),
        description: "Local Swagger Petstore API fixture.",
        instanceKey: "agent-openapi-swagger:petstore",
        operations: { allow: ["getInventory"] },
        spec: PETSTORE_SPEC,
      }),
    }),
  },
});
