import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: "https://petstore.swagger.io/v2/swagger.json",
  description: "Swagger Petstore API from its public Swagger 2.0 document.",
  operations: { allow: ["getInventory"] },
});
