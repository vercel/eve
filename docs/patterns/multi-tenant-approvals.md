---
title: "Multi-Tenant Approvals"
description: "Resolve tenant policy asynchronously for authored tools, OpenAPI operations, and MCP tools."
---

Multi-tenant approvals let your application decide, per tenant, whether a tool call is allowed, denied, or needs human confirmation. eve's `approval` field takes an async function that receives the session, the full tool name, and the tool input. One adapter turns those into a request to your policy store. Tools, OpenAPI connections, and MCP connections all use the same adapter.

Use this with [multi-tenant outbound auth](./multi-tenant-auth) when your own
API key, JWT, or app session establishes the tenant. In that pattern, your
credential store supplies the connection credential instead of OAuth.

You store tenant policy. It can be a few columns in PostgreSQL, a policy service, an authorization engine, or configuration in a KV store.

## Adapt tenant policy to eve approval

This adapter checks that the current caller and the caller who started the session belong to the same tenant. Then it asks your policy store:

```ts title="agent/lib/tenant-approval.ts"
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import { approvalPolicies } from "./approval-policies";

type Surface = "connection" | "tool";

function tenantIdOf(auth: ApprovalContext["session"]["auth"]["current"]): string | null {
  const tenantId = auth?.attributes.tenantId;
  return typeof tenantId === "string" ? tenantId : null;
}

export async function decideTenantApproval(
  surface: Surface,
  ctx: ApprovalContext,
): Promise<ApprovalStatus> {
  const current = ctx.session.auth.current;
  const tenantId = tenantIdOf(current);
  const initiatorTenantId = tenantIdOf(ctx.session.auth.initiator);

  if (current?.principalType !== "user" || !tenantId || tenantId !== initiatorTenantId) {
    return { type: "denied", reason: "The session is not pinned to one tenant user." };
  }

  const input = ctx.toolInput as Record<string, unknown> | undefined;
  if (typeof input?.tenantId === "string" && input.tenantId !== tenantId) {
    return { type: "denied", reason: "Tool input cannot select another tenant." };
  }

  const policy = await approvalPolicies.decide({
    tenantId,
    userId: current.principalId,
    resource: `${surface}:${ctx.toolName}`,
    input,
  });

  switch (policy.decision) {
    case "allow":
      return { type: "approved", reason: policy.reason };
    case "require-approval":
      return "user-approval";
    case "deny":
      return { type: "denied", reason: policy.reason };
  }
}
```

For authored tools, `ctx.toolName` is the path-derived name such as `transfer_funds`. For connection tools, it includes the connection name, such as `billing__updateSubscription` or `support__add_internal_note`. Your policy service can match exact names, patterns for a whole connection, roles, amounts, environments, or any other rule the tenant sets.

The function runs for every call, so `"user-approval"` asks for a separate decision on each action. [`once()`](/docs/human-in-the-loop#remember-approval-for-a-tool) remembers approval for the tool across all inputs in the session. It does not create grants for a tenant.

## Apply it to an authored tool

Approval runs before `execute`. `execute` must still read and enforce the tenant, because approval is a gate, not authorization:

```ts title="agent/tools/transfer_funds.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { transferFunds } from "../../lib/payments";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineTool({
  description: "Transfer funds from the current tenant's account.",
  inputSchema: z.object({
    destinationAccountId: z.string().min(1),
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
  approval: (ctx) => decideTenantApproval("tool", ctx),
  async execute(input, ctx) {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") {
      throw new Error("An authenticated tenant is required.");
    }

    return await transferFunds({
      ...input,
      tenantId,
      idempotencyKey: `${ctx.session.id}:${ctx.session.turn.id}`,
    });
  },
});
```

Use an idempotency key from your application for side effects, because approval doesn't make a repeated step safe.

## Apply it to an OpenAPI connection

The same function gates every generated operation. The full operation name lets tenant policy tell reads from writes:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineOpenAPIConnection({
  spec: "https://billing.example.com/openapi.json",
  description: "Billing operations for the authenticated tenant.",
  operations: { allow: ["listInvoices", "updateSubscription"] },
  headers: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") throw new Error("Tenant is required.");
    return {
      "X-Service-Token": process.env.BILLING_SERVICE_TOKEN!,
      "X-Tenant-Id": tenantId,
    };
  },
  approval: (ctx) => decideTenantApproval("connection", ctx),
});
```

The allow-list limits which operations the model can find. Approval decides whether a found operation may run.

## Apply it to an MCP connection

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets for the authenticated tenant.",
  tools: { allow: ["search_tickets", "add_internal_note"] },
  headers: async (ctx) => {
    const tenantId = ctx.session.auth.current?.attributes.tenantId;
    if (typeof tenantId !== "string") throw new Error("Tenant is required.");
    return {
      "X-Service-Token": process.env.SUPPORT_SERVICE_TOKEN!,
      "X-Tenant-Id": tenantId,
    };
  },
  approval: (ctx) => decideTenantApproval("connection", ctx),
});
```

The policy receives `connection:support__search_tickets` or `connection:support__add_internal_note` as its resource.

## Supply the policy adapter

The adapter needs only this interface:

```ts title="agent/lib/approval-policies.ts"
export interface ApprovalPolicyRequest {
  tenantId: string;
  userId: string;
  resource: string;
  input?: Record<string, unknown>;
}

export interface ApprovalPolicyDecision {
  decision: "allow" | "deny" | "require-approval";
  reason?: string;
}

export interface ApprovalPolicyProvider {
  decide(request: ApprovalPolicyRequest): Promise<ApprovalPolicyDecision>;
}

export { approvalPolicies } from "../../lib/approval-policies";
```

Your provider decides the policy model. A common implementation checks tenant membership and looks for an exact resource rule, then a rule for the whole connection. It checks role and input thresholds, and it denies by default.

When a policy lookup fails, throw or deny. Never allow silently. Check authorization again inside `execute` for tools with side effects, because membership or policy can change while the session waits for approval.

## Protect the approval response

An approval pauses the session, and the pause survives restarts and redeploys. A later request resumes the session. Your HTTP boundary must stop a caller from continuing or streaming another tenant's session. Save which tenant and user each session belongs to, and check it before you forward these requests:

- `POST /eve/v1/session/:sessionId`, including `answers`;
- `GET /eve/v1/session/:sessionId/stream`.

By default, only the caller whose turn requested the call can approve or cancel it. To change who may respond, add an [approval response policy](/docs/human-in-the-loop#authorizing-approval-responses). The policy receives the responder as `response.principal` and the requester as `request.principal`. It runs for both Approve and Cancel.

For a four-eyes workflow, where a different person or role must approve, branch on `response.decision`. Allow `deny` so the requester can still cancel the call. For `approve`, reject a `response.principal` that matches `request.principal`, and check the responder's role.
