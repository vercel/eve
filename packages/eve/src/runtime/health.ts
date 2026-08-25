import { workflowEntryReference } from "#execution/workflow-runtime.js";

/**
 * Builds the public health payload served by the framework eve channel at
 * `/eve/v1/health`. Process readiness is a separate non-HTTP host
 * capability; this route is the replaceable public health contract that
 * `Client.health()` validates.
 */
export function buildEveHealthResponse(): Response {
  return Response.json({
    ok: true,
    status: "ready",
    workflowId: workflowEntryReference.workflowId,
  });
}
