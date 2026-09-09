export const DEPLOYMENT_REVISION_HEADER = "x-eve-e2e-deployment-revision";
export const DEPLOYMENT_PENDING_CODE = "e2e_deployment_pending";

export function checkDeploymentRevision(
  request: Request,
  revision = process.env.EVE_E2E_DEPLOYMENT_REVISION,
): Response | undefined {
  const expected = request.headers.get(DEPLOYMENT_REVISION_HEADER);
  if (expected === null || expected === revision) return undefined;
  return Response.json(
    {
      code: DEPLOYMENT_PENDING_CODE,
      error: "The requested deployment is not serving this request yet.",
    },
    { status: 409 },
  );
}
