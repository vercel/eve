import { defineDynamic, defineOpenAPIConnection } from "eve/connections";

export default defineDynamic({
  events: {
    "session.started": () => ({
      "dynamic-catalog": defineOpenAPIConnection({
        baseUrl: "https://catalog.example.com",
        description: "Caller-specific product catalog.",
        operations: { allow: ["getStatus"] },
        spec: {
          info: { title: "Dynamic catalog", version: "1.0.0" },
          openapi: "3.0.0",
          paths: {
            "/status": {
              get: {
                operationId: "getStatus",
                responses: { 200: { description: "Catalog status." } },
                summary: "Read catalog status.",
              },
            },
          },
        },
      }),
    }),
  },
});
