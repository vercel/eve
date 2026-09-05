import { defineOpenAPIConnection } from "eve/connections";
import { never } from "eve/tools/approval";

export default defineOpenAPIConnection({
  approval: never(),
  baseUrl: "https://catalog.example.com",
  description: "Inline catalog for code mode discovery.",
  spec: {
    openapi: "3.0.0",
    info: { title: "Code mode catalog", version: "1.0.0" },
    paths: {
      "/status": {
        get: {
          operationId: "getStatus",
          summary: "Read catalog status.",
          responses: { 200: { description: "Catalog status." } },
        },
      },
    },
  },
});
