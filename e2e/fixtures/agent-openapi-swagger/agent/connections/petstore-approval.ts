import { defineDynamic, defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

import { petstoreBaseUrl } from "../../petstore";

export default defineDynamic({
  events: {
    "session.started": () => ({
      "petstore-approval": defineOpenAPIConnection({
        approval: always(),
        baseUrl: petstoreBaseUrl(),
        spec: `${petstoreBaseUrl()}/swagger`,
        description:
          "Approval-gated sample Petstore API from a fixture-owned Swagger 2.0 document.",
        operations: { allow: ["getInventory"] },
      }),
    }),
  },
});
