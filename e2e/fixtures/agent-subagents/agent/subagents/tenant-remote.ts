import { defineDynamic, defineRemoteAgent } from "eve";

import { TENANT_AUTHORIZATIONS, type Tenant } from "../../constants";

const tenantOf = (principalId: string | null): Tenant =>
  principalId === "e2e-user-2" ? "globex" : "acme";

/**
 * A dynamic remote agent whose credentials follow the caller: `record` picks the caller's tenant,
 * and `render` sends that tenant's bearer to this same deployment, whose eve channel runs each
 * bearer as its tenant's service principal (see `agent/channels/eve.ts`). A child keeps the
 * tenant it was opened with, whoever asks next.
 */
export default defineDynamic({
  select: (_view, ctx) => ctx.session.auth.current?.principalId ?? null,
  record: (principalId) => ({ tenant: tenantOf(principalId) }),
  render: ({ tenant }) => {
    const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    return defineRemoteAgent({
      description:
        "Tenant remote agent. Call this only when the user explicitly asks for the tenant-remote agent.",
      url:
        process.env.VERCEL_URL !== undefined && process.env.VERCEL_URL !== ""
          ? `https://${process.env.VERCEL_URL}`
          : (process.env.WORKFLOW_LOCAL_BASE_URL ?? "http://127.0.0.1:3000"),
      headers: {
        authorization: TENANT_AUTHORIZATIONS[tenant],
        // Preview deployments behind deployment protection need the bypass on the self-call.
        ...(bypass !== undefined && bypass !== "" && { "x-vercel-protection-bypass": bypass }),
      },
    });
  },
});
