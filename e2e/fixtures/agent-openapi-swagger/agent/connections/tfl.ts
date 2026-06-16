import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: "https://api.tfl.gov.uk/swagger/docs/v1",
  description: "Transport for London Unified API from its public Swagger 2.0 document.",
  operations: { allow: ["Journey_Meta"] },
});
