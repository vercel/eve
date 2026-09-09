import { defineDynamic, defineOpenAPIConnection } from "eve/connections";

import { petstoreBaseUrl } from "../../petstore";

export default defineDynamic({
  events: {
    "session.started": () => ({
      petstore: defineOpenAPIConnection({
        baseUrl: petstoreBaseUrl(),
        spec: `${petstoreBaseUrl()}/swagger`,
        description: "Sample Petstore API from a fixture-owned Swagger 2.0 document.",
        operations: { allow: ["getInventory"] },
      }),
    }),
  },
});
