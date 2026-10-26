import { type AuthFn, vercelOidc } from "#public/channels/auth.js";

/**
 * Vercel OIDC from this project in the current environment only. Tokens from
 * the project's other environments, such as a preview deployment, authenticate
 * as `service` and must not reach this deployment's inbound channel routes.
 */
export function sameEnvironmentVercelOidc(): AuthFn<Request> {
  const oidc = vercelOidc();
  return async (request) => {
    const auth = await oidc(request);
    return auth?.principalType === "runtime" ? auth : null;
  };
}
