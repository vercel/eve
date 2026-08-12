import { defineOpenAPIConnection } from "#public/connections/index.js";

export default defineOpenAPIConnection({
  baseUrl: "https://api.example.com",
  description: "Example service described by an OpenAPI document",
  spec: "https://api.example.com/openapi.json",
});
