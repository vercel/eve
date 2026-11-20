import { type AuthFn, vercelOidc } from "#public/channels/auth.js";

export function sameEnvironmentVercelOidc(): AuthFn<Request> {
  const oidc = vercelOidc();
  return async (request) => {
    const auth = await oidc(request);
    return auth?.principalType === "runtime" ? auth : null;
  };
}
