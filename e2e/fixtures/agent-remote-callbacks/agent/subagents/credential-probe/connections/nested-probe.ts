import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineOpenAPIConnection,
} from "eve/connections";

/**
 * Same interactive-authorization trigger as the root `probe` connection,
 * but owned by a local subagent: when this agent runs as a remote callee's
 * child, its `authorization.*` events must relay two hops — local proxy to
 * the callee's stream, then a notification callback to the original caller.
 */
function selfBaseUrl(): string {
  const local = process.env.WORKFLOW_LOCAL_BASE_URL?.trim();
  if (local) return local;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  // Module evaluation also happens during a bare `eve build`, where no
  // runtime origin exists yet. The dev runtime re-evaluates this module
  // with the real origin before any request is served, and Vercel builds
  // have VERCEL_URL, so the placeholder never receives a request.
  return "http://127.0.0.1:65535";
}

export default defineOpenAPIConnection({
  spec: {
    openapi: "3.0.3",
    info: { title: "Nested probe credential API", version: "1.0.0" },
    paths: {
      "/probe/credential": {
        get: {
          operationId: "get_credential",
          summary: "Return the nested probe credential for the authorized caller.",
          responses: {
            "200": {
              description: "The nested probe credential.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { credential: { type: "string" } },
                    required: ["credential"],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  // Property getter: module evaluation happens before the dev host
  // publishes its origin, so defer the read until the runtime resolves
  // the connection (post-boot, env set).
  get baseUrl(): string {
    return selfBaseUrl();
  },
  description:
    "Nested probe credential API. Exposes get_credential, which returns the nested credential string.",
  auth: defineInteractiveAuthorization({
    async getToken() {
      throw new ConnectionAuthorizationRequiredError("nested-probe");
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: { url: callbackUrl, instructions: "Open the link to authorize the probe." },
      };
    },
    async completeAuthorization({ callback }) {
      const code = callback.params.code;
      if (code === undefined || code.length === 0) {
        throw new ConnectionAuthorizationFailedError("nested-probe", {
          reason: "missing_code",
          retryable: false,
        });
      }
      return { token: `nested-probe:${code}` };
    },
  }),
});
