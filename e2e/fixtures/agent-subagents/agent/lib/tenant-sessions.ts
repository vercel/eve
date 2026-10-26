/**
 * The sessions that ran as a tenant's service principal in this process. The eve channel refuses
 * to stream them to a caller without a tenant's bearer, so a proxy that forgot a child's
 * credentials fails rather than reading the child as the anonymous default user.
 */
export const tenantSessions = new Set<string>();

/** The session a stream request reads, or `undefined` for every other route. */
export function streamedSessionId(request: Request): string | undefined {
  if (request.method !== "GET") return undefined;
  return new URL(request.url).pathname.match(/\/eve\/v1\/session\/([^/]+)\/stream$/)?.[1];
}
