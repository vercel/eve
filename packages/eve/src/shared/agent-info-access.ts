import { ClientError } from "#client/client-error.js";
import { AGENT_INFO_FORBIDDEN_CODE } from "#protocol/routes.js";

/** Whether a client error is the info route refusing a non-operator principal. */
export function isAgentInfoForbidden(error: unknown): error is ClientError {
  return (
    error instanceof ClientError && error.status === 403 && error.code === AGENT_INFO_FORBIDDEN_CODE
  );
}

/** Says which credential `GET /eve/v1/info` accepts, for callers it refused. */
export function formatAgentInfoForbiddenMessage(target: string): string {
  return `${target} refused GET /eve/v1/info because the credential is not an operator. Agent info is served only to service, runtime, and local-dev principals: authenticate as a service principal, for example with Vercel OIDC, jwtHmac() or jwtEcdsa(), or a custom AuthFn that returns principalType "service".`;
}
