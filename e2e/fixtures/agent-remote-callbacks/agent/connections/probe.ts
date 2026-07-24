import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  defineOpenAPIConnection,
} from "eve/connections";

/**
 * Deterministic interactive-authorization trigger for the remote-callback
 * evals: `get_credential` targets this deployment's own `/probe/credential`
 * route, and the first use parks the turn on an authorization hook. The
 * eval completes the hook with a `?code=`; `completeAuthorization` mints
 * the bearer from that code, so the credential the route returns proves
 * the callback propagated end to end.
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

// No cross-step token cache: the runtime's per-step cache covers the
// resumed step that runs the operation, and every eval session shares one
// user principal — a module-level cache would bleed a token authorized by
// one eval into the next session and suppress its authorization.required.

export default defineOpenAPIConnection({
  spec: {
    openapi: "3.0.3",
    info: { title: "Probe credential API", version: "1.0.0" },
    paths: {
      "/probe/credential": {
        get: {
          operationId: "get_credential",
          summary: "Return the probe credential for the authorized caller.",
          responses: {
            "200": {
              description: "The probe credential.",
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
    "Probe credential API. Exposes get_credential, which returns the probe credential string.",
  auth: defineInteractiveAuthorization({
    async getToken() {
      throw new ConnectionAuthorizationRequiredError("probe");
    },
    async startAuthorization({ callbackUrl }) {
      return {
        challenge: { url: callbackUrl, instructions: "Open the link to authorize the probe." },
      };
    },
    async completeAuthorization({ callback }) {
      const code = callback.params.code;
      if (code === undefined || code.length === 0) {
        throw new ConnectionAuthorizationFailedError("probe", {
          reason: "missing_code",
          retryable: false,
        });
      }
      return { token: `probe:${code}` };
    },
  }),
});
