---
title: "Multi-tenant approvals"
description: "Resolve tenant policy asynchronously for authored tools, OpenAPI operations, and MCP tools."
---

eve's `approval` field is an async policy hook. It receives the active session, qualified tool name, tool input, and previously approved tools. That is enough to ask your application whether this tenant should allow, deny, or require human confirmation for any authored or connection tool.

Use this with [multi-tenant outbound auth](./multi-tenant-auth) when your own
API key, JWT, or app session establishes the tenant and the connection
credential is selected from your credential store rather than OAuth.

The pattern has two pieces:

1. one adapter translates eve's approval context into an application policy request;
2. tools, OpenAPI connections, and MCP connections reuse that adapter.

Tenant policy storage remains yours. It might be a few columns in PostgreSQL, a policy service, an authorization engine, or configuration in a durable KV store.

## Adapt tenant policy to eve approval

The current caller and initiating caller are both available on the session. This example requires them to belong to the same tenant before consulting policy:

```ts title="agent/lib/tenant-approval.ts"
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
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

For authored tools, `ctx.toolName` is the path-derived name such as `transfer_funds`. For connection tools, it is qualified, such as `billing__updateSubscription` or `support__add_internal_note`. Your policy service can match exact names, connection-wide patterns, roles, amounts, environments, or any other tenant-owned rule.

The callback deliberately does not treat `approvedTools` as a session-wide grant. Every call is evaluated. If your policy supports approve-once behavior, consult `ctx.approvedTools` explicitly after pinning the session tenant.

## Apply it to an authored tool

Approval runs before `execute`. The executor must still derive and enforce tenancy again because approval is a gate, not authorization:

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

Use an application idempotency key for side effects. Human approval and replay safety solve different problems.

## Apply it to an OpenAPI connection

The same callback gates every generated operation. The qualified operation name lets tenant policy distinguish reads from writes:

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

The allow-list limits what the model can discover. Approval independently decides whether a discovered operation may run.

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

The eve code needs only this interface:

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

Your provider decides the policy model. A common implementation checks active tenant membership, finds an exact resource rule before a connection-wide fallback, evaluates role and input thresholds, and defaults to deny. Keep those choices in application code rather than encoding a database design into the agent.

Policy lookup failures should throw or deny, never silently allow. Recheck authorization inside side-effecting executors because membership or policy can change while a run is parked.

## Protect the approval response

An approval durably pauses the session and a later request resumes it. Your HTTP boundary must ensure a caller cannot continue or stream a session owned by another tenant. Persist session ownership in your application and check it before proxying:

- `POST /eve/v1/session/:sessionId`, including `inputResponses`;
- `GET /eve/v1/session/:sessionId/stream`.

Built-in approval confirms that a human with access to the session approved the call. It is not a four-eyes workflow that proves a different person or role approved it. For that requirement, create an application-owned approval request, notify eligible approvers through a channel, and have policy return allow only after that request records an authorized decision.

The complete eve integration is one async adapter reused by tools and both connection protocols. The tenant's rule storage and governance model remain application concerns.
