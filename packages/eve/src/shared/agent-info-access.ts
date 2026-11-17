import { ClientError } from "#client/client-error.js";
import { AGENT_INFO_FORBIDDEN_CODE, AGENT_INFO_FORBIDDEN_MESSAGE } from "#protocol/routes.js";

export function isAgentInfoForbidden(error: unknown): error is ClientError {
  return (
    error instanceof ClientError && error.status === 403 && error.code === AGENT_INFO_FORBIDDEN_CODE
  );
}

export function formatAgentInfoForbiddenMessage(target: string): string {
  return `${target} refused GET /eve/v1/info. ${AGENT_INFO_FORBIDDEN_MESSAGE}`;
}
