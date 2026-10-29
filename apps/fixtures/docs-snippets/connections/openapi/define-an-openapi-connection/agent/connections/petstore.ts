import { defineOpenAPIConnection } from "eve/connections";

export default defineOpenAPIConnection({
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  description: "Pet store inventory and orders.",
  auth: {
    principalType: "app",
    getToken: async () => ({ token: process.env.PETSTORE_TOKEN! }),
  },
});
