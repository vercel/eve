import { defineOpenAPIConnection } from "eve/connections";
import { always } from "eve/tools/approval";

export default defineOpenAPIConnection({
  approval: always(),
  baseUrl: "https://api.tfl.gov.uk",
  spec: "https://api.tfl.gov.uk/swagger/docs/v1",
  description:
    "Approval-gated Transport for London Unified API from its public Swagger 2.0 document.",
  operations: { allow: ["Journey_Meta"] },
});
