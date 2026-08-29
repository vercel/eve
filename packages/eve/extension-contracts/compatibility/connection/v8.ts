import { defineOpenAPIConnection } from "#public/connections/index.js";

export default defineOpenAPIConnection({
  auth: { getToken: async () => ({ token: "token" }) },
  baseUrl: "https://api.example.com",
  description: "Tenant-aware OpenAPI service",
  headers: { "X-Tenant": ({ session }) => session.id },
  operations: { allow: ["getProject"] },
  spec: "https://api.example.com/openapi.json",
  toolCall: {
    providedArguments: {
      teamId: ({ callId, session, toolName }) => `${session.id}:${toolName}:${callId}`,
    },
  },
});
