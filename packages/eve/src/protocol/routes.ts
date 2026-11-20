export const EVE_ROUTE_PREFIX = "/eve/v1";

export const EVE_HEALTH_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/health`;

export const EVE_INFO_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/info`;

export const AGENT_INFO_FORBIDDEN_CODE = "info_forbidden";

export const AGENT_INFO_FORBIDDEN_MESSAGE =
  'Agent info is served only to operator credentials (principalType "service", "runtime", or "local-dev"). Authenticate as a service principal, for example with Vercel OIDC, or return allowAgentInfo: true from the eve channel\'s auth for this caller.';

export const EVE_SESSION_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/session`;

export const EVE_SESSION_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId`;

export const EVE_SESSION_CANCEL_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/cancel`;

export const EVE_SESSION_COMPACT_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/compact`;

export const EVE_SESSION_CLEAR_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/clear`;

export const EVE_SESSION_END_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/end`;

export const EVE_SESSION_RESET_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/reset`;

export const EVE_SESSION_STUBS_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stubs`;

export const EVE_SESSION_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/stream`;

export const EVE_DESCENDANT_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:sessionId/descendants/stream`;

export function createEveDescendantStreamRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/descendants/stream`;
}

export const EVE_SUBAGENT_STREAM_ROUTE_PATTERN = `${EVE_SESSION_ROUTE_PATH}/:parentSessionId/subagents/:callId/:childSessionId/stream`;

export const EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/dev/schedules/:scheduleId`;

export const EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/dev/runtime-artifacts`;

export const EVE_DEV_RUNTIME_ARTIFACTS_REBUILD_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/rebuild`;

export const EVE_DEV_RUNTIME_ARTIFACTS_SUSPEND_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/suspend`;

export const EVE_DEV_RUNTIME_ARTIFACTS_RESUME_ROUTE_PATH = `${EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH}/resume`;

export function createEveDevDispatchSchedulePath(scheduleId: string): string {
  return `${EVE_ROUTE_PREFIX}/dev/schedules/${encodeURIComponent(scheduleId)}`;
}

export const EVE_CONNECTION_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/connections/:name/callback/:attemptId/:token`;

export const EVE_CALLBACK_ROUTE_PATTERN = `${EVE_ROUTE_PREFIX}/callback/:token`;

export function createEveSessionRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}`;
}

export function createEveSessionCancelRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/cancel`;
}

export function createEveSubagentStreamRoutePath(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly parentSessionId: string;
}): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(input.parentSessionId)}/subagents/${encodeURIComponent(input.callId)}/${encodeURIComponent(input.childSessionId)}/stream`;
}

export function createEveSessionCompactRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/compact`;
}

export function createEveSessionClearRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/clear`;
}

export function createEveSessionEndRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/end`;
}

export function createEveSessionResetRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/reset`;
}

export function createEveSessionStreamRoutePath(sessionId: string): string {
  return `${EVE_SESSION_ROUTE_PATH}/${encodeURIComponent(sessionId)}/stream`;
}

export function createEveConnectionCallbackRoutePath(
  name: string,
  attemptId: string,
  token: string,
): string {
  return `${EVE_ROUTE_PREFIX}/connections/${encodeURIComponent(name)}/callback/${encodeURIComponent(attemptId)}/${encodeURIComponent(token)}`;
}

export function parseEveConnectionCallbackRoutePath(
  pathname: string,
): { readonly name: string; readonly attemptId: string; readonly token: string } | undefined {
  const segments = pathname.split("/");
  const [connections, name, callback, attemptId, token] = segments.slice(-5);
  if (connections !== "connections" || callback !== "callback") return undefined;
  if (!name || !attemptId || !token) return undefined;
  const decoded = [name, attemptId, token].map(decodedSegment);
  const [decodedName, decodedAttemptId, decodedToken] = decoded;
  if (decodedName === undefined || decodedAttemptId === undefined || decodedToken === undefined)
    return undefined;
  return { attemptId: decodedAttemptId, name: decodedName, token: decodedToken };
}

function decodedSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

export function createEveCallbackRoutePath(token: string): string {
  return `${EVE_ROUTE_PREFIX}/callback/${encodeURIComponent(token)}`;
}

export function createEveSessionStubsRoutePath(sessionId: string): string {
  return `${createEveSessionRoutePath(sessionId)}/stubs`;
}

export const DEVELOPMENT_WORKFLOW_WORLD_ROUTE = `${EVE_ROUTE_PREFIX}/dev/internal/workflow-world`;

export const DEVELOPMENT_WORKFLOW_STREAM_ROUTE = `${DEVELOPMENT_WORKFLOW_WORLD_ROUTE}/stream`;
