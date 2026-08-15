import { defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

export default defineOpenAPIConnection({
  approval: always(),
  baseUrl: "https://petstore.swagger.io/v2",
  spec: "https://petstore.swagger.io/v2/swagger.json",
  description: "Approval-gated Swagger Petstore API from its public Swagger 2.0 document.",
  operations: { allow: ["getInventory"] },
});
