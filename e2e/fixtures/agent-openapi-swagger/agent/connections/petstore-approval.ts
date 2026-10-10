import { defineDynamic, defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

import { petstoreBaseUrl, petstoreHeaders, petstoreSpecUrl } from "../../petstore";

export default defineDynamic({
  resolve: () => ({
    "petstore-approval": defineOpenAPIConnection({
      approval: always(),
      baseUrl: petstoreBaseUrl(),
      spec: petstoreSpecUrl(),
      headers: petstoreHeaders(),
      description: "Approval-gated sample Petstore API from a fixture-owned Swagger 2.0 document.",
      operations: { allow: ["getInventory"] },
    }),
  }),
});
