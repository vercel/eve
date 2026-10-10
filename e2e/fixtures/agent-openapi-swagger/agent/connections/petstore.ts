import { defineDynamic, defineOpenAPIConnection } from "eve/connections";

import { petstoreBaseUrl, petstoreHeaders, petstoreSpecUrl } from "../../petstore";

export default defineDynamic({
  resolve: () => ({
    petstore: defineOpenAPIConnection({
      baseUrl: petstoreBaseUrl(),
      spec: petstoreSpecUrl(),
      headers: petstoreHeaders(),
      description: "Sample Petstore API from a fixture-owned Swagger 2.0 document.",
      operations: { allow: ["getInventory", "addPet"] },
    }),
  }),
});
