---
title: "Multi-tenant approvals"
description: "Resolve tenant policy asynchronously for authored tools, OpenAPI operations, and MCP tools, with fail-closed defaults."
---

Approval is a function, so it can be a policy adapter rather than a static `always()` or `once()`. The function receives the active session, qualified tool name, model-supplied input, and previously approved tools, and it may return a promise. That is enough to load the current tenant's policy from a database before an authored tool or connection tool runs.

Multi-tenant approval is not a separate eve subsystem. In this example:

- route auth supplies the verified tenant and user;
- PostgreSQL owns tenant membership and policy;
- one async policy function returns `"approved"`, `"denied"`, or `"user-approval"`;
- authored tools, OpenAPI connections, and MCP connections reuse it;
- tool execution checks tenancy again after approval.

## 1. Model tenant policy

The example assumes your application has a `tenant_members` table. Policies name the exact runtime tool, with a wildcard fallback for all tools in one connection.

```sql title="db/migrations/004_tenant_approvals.sql"
CREATE TABLE tenant_members (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE tenant_approval_policies (
  tenant_id text NOT NULL,
  resource text NOT NULL,
  action text NOT NULL
    CHECK (action IN ('allow', 'deny', 'require_approval')),
  allowed_roles text[] NOT NULL DEFAULT '{}',
  min_amount numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, resource),
  CHECK (min_amount IS NULL OR min_amount >= 0)
);

CREATE TABLE approval_policy_evaluations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  resource text NOT NULL,
  outcome text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Resource names in this example are:

```text
tool:transfer_funds
connection:billing__listInvoices
connection:billing__updateSubscription
connection:billing__*
connection:support__search_tickets
connection:support__add_internal_note
connection:support__*
```

Exact connection-tool policy wins over `<connection>__*`. No matching row means deny.

For example, one tenant can auto-allow invoice reads, require a finance user to approve large transfers, and deny every unlisted support action:

```sql
INSERT INTO tenant_approval_policies
  (tenant_id, resource, action, allowed_roles, min_amount)
VALUES
  ('tenant_acme', 'tool:transfer_funds', 'require_approval', ARRAY['finance'], 500),
  ('tenant_acme', 'connection:billing__listInvoices', 'allow', ARRAY['finance', 'viewer'], NULL),
  ('tenant_acme', 'connection:billing__updateSubscription', 'require_approval', ARRAY['finance'], NULL),
  ('tenant_acme', 'connection:support__*', 'deny', '{}', NULL),
  ('tenant_acme', 'connection:support__search_tickets', 'allow', ARRAY['support'], NULL);
```

`min_amount` means “prompt at or above this amount.” If the tool input has no numeric `amount`, the evaluator prompts rather than guessing that it is below the threshold.

## 2. Connect to the policy database

```sh
pnpm add postgres
```

```ts title="agent/lib/db.ts"
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
export const sql = postgres(process.env.DATABASE_URL, { max: 5, prepare: false });
```

## 3. Implement one fail-closed evaluator

The evaluator uses `session.auth.current`, because approval is being decided for the caller of this turn. It also pins the turn to the initiating tenant. This prevents a continuation authenticated as a different tenant from inheriting the session's context.

```ts title="agent/lib/tenant-approval.ts"
import type { ApprovalContext, ApprovalStatus } from "eve/tools";
import { sql } from "./db.js";

type Surface = "connection" | "tool";

interface PolicyRow {
  resource: string;
  action: "allow" | "deny" | "require_approval";
  allowed_roles: string[];
  min_amount: string | null;
}

function tenantIdOf(auth: ApprovalContext["session"]["auth"]["current"]): string | null {
  const tenantId = auth?.attributes.tenantId;
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
}

function inputTenantId(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).tenantId;
  return typeof value === "string" ? value : null;
}

function inputAmount(input: unknown): number | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>).amount;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function policyCandidates(surface: Surface, toolName: string): string[] {
  const exact = `${surface}:${toolName}`;
  if (surface !== "connection") return [exact];
  const separator = toolName.indexOf("__");
  return separator === -1 ? [exact] : [exact, `connection:${toolName.slice(0, separator)}__*`];
}

async function audit(input: {
  ctx: ApprovalContext;
  tenantId: string;
  userId: string;
  resource: string;
  outcome: string;
  reason?: string;
}): Promise<void> {
  await sql`
    INSERT INTO approval_policy_evaluations (
      id, tenant_id, user_id, session_id, turn_id, resource, outcome, reason
    ) VALUES (
      ${crypto.randomUUID()}, ${input.tenantId}, ${input.userId},
      ${input.ctx.session.id}, ${input.ctx.session.turn.id}, ${input.resource},
      ${input.outcome}, ${input.reason ?? null}
    )
  `;
}

export async function decideTenantApproval(
  surface: Surface,
  ctx: ApprovalContext,
): Promise<ApprovalStatus> {
  const current = ctx.session.auth.current;
  const initiator = ctx.session.auth.initiator;
  const tenantId = tenantIdOf(current);
  const initiatorTenantId = tenantIdOf(initiator);
  const userId = current?.principalId;
  const resource = `${surface}:${ctx.toolName}`;

  if (current?.principalType !== "user" || !userId || !tenantId || tenantId !== initiatorTenantId) {
    return { type: "denied", reason: "The session is not pinned to one tenant user." };
  }

  const requestedTenantId = inputTenantId(ctx.toolInput);
  if (requestedTenantId !== null && requestedTenantId !== tenantId) {
    await audit({
      ctx,
      tenantId,
      userId,
      resource,
      outcome: "denied",
      reason: "Cross-tenant input",
    });
    return { type: "denied", reason: "Tool input cannot select another tenant." };
  }

  const [member] = await sql<{ role: string }[]>`
    SELECT role
    FROM tenant_members
    WHERE tenant_id = ${tenantId} AND user_id = ${userId} AND active = true
  `;
  if (!member) {
    return { type: "denied", reason: "The caller is not an active tenant member." };
  }

  const candidates = policyCandidates(surface, ctx.toolName);
  const policies = await sql<PolicyRow[]>`
    SELECT resource, action, allowed_roles, min_amount
    FROM tenant_approval_policies
    WHERE tenant_id = ${tenantId} AND resource = ANY(${candidates})
  `;
  const policy =
    policies.find((row) => row.resource === candidates[0]) ??
    policies.find((row) => row.resource === candidates[1]);

  if (!policy) {
    await audit({ ctx, tenantId, userId, resource, outcome: "denied", reason: "No policy" });
    return { type: "denied", reason: "No tenant approval policy allows this action." };
  }

  if (policy.allowed_roles.length > 0 && !policy.allowed_roles.includes(member.role)) {
    await audit({
      ctx,
      tenantId,
      userId,
      resource,
      outcome: "denied",
      reason: `Role ${member.role} is not allowed`,
    });
    return { type: "denied", reason: "The caller's tenant role cannot perform this action." };
  }

  if (policy.action === "deny") {
    await audit({ ctx, tenantId, userId, resource, outcome: "denied" });
    return { type: "denied", reason: "Tenant policy denies this action." };
  }

  if (policy.action === "allow") {
    await audit({ ctx, tenantId, userId, resource, outcome: "approved" });
    return { type: "approved", reason: "Allowed by tenant policy." };
  }

  const threshold = policy.min_amount === null ? null : Number(policy.min_amount);
  const amount = inputAmount(ctx.toolInput);
  const needsHuman = threshold === null || amount === null || amount >= threshold;
  const outcome = needsHuman ? "user-approval" : "approved";
  await audit({ ctx, tenantId, userId, resource, outcome });
  return needsHuman
    ? "user-approval"
    : { type: "approved", reason: "Below the tenant's approval threshold." };
}
```

The policy deliberately ignores `approvedTools`. This makes the decision apply to every call and avoids turning one approval into a session-wide grant. If your tenant policy allows session-wide approval, consult `approvedTools` explicitly and pin the session tenant before honoring it.

Database failures throw and stop the tool call. Do not catch them and return approval: a policy service outage should fail closed.

## 4. Apply the policy to an authored tool

The approval callback runs before `execute`. The executor still derives tenancy again: approval is a gate, not a replacement for authorization.

```ts title="agent/lib/payments.ts"
import { createHash } from "node:crypto";

export async function transferFunds(input: {
  tenantId: string;
  sessionId: string;
  turnId: string;
  destinationAccountId: string;
  amount: number;
  currency: string;
}) {
  const idempotencyKey = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const response = await fetch("https://payments.internal.example/v1/transfers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.PAYMENTS_SERVICE_TOKEN!}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-tenant-id": input.tenantId,
    },
    body: JSON.stringify({
      destinationAccountId: input.destinationAccountId,
      amount: input.amount,
      currency: input.currency,
    }),
  });
  if (!response.ok) throw new Error(`Payments service returned ${response.status}.`);
  return await response.json();
}
```

```ts title="agent/tools/transfer_funds.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { transferFunds } from "../lib/payments.js";
import { decideTenantApproval } from "../lib/tenant-approval.js";

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
      sessionId: ctx.session.id,
      turnId: ctx.session.turn.id,
    });
  },
});
```

The idempotency key protects the side effect if the execution step is retried. Human approval and idempotency solve different problems; use both for money movement.

## 5. Apply the policy to an OpenAPI connection

Connection tools pass their qualified runtime name, such as `billing__updateSubscription`, to the same callback:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval.js";

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

The operation allow-list controls what the model can discover. The async approval policy independently decides whether a discovered call is allowed, denied, or must pause for a person.

## 6. Apply the policy to an MCP connection

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { decideTenantApproval } from "../lib/tenant-approval.js";

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

The policy sees `support__search_tickets` or `support__add_internal_note`. It first looks for that exact resource, then falls back to `connection:support__*`.

## 7. Protect approval responses by tenant

An approval pauses the durable session and a later request resumes it. Your HTTP boundary must ensure a caller cannot continue or stream a session owned by another tenant. eve authenticates routes but does not invent your session ACL.

A straightforward application-level design is:

1. Persist `{ sessionId, tenantId }` when the create-session response is returned to your backend-for-frontend.
2. Before proxying `POST /eve/v1/session/:sessionId` (including `inputResponses`) or `GET /eve/v1/session/:sessionId/stream`, compare that owner to the verified tenant.
3. Return `404` or `403` on a mismatch before the request reaches eve.

Do the same in a custom channel if clients call eve directly. This is what ensures the person answering a prompt belongs to the same tenant as the requester.

The built-in approval is confirmation by a human who can access the session. It is not, by itself, a four-eyes workflow that proves the approver differs from the requester or has a second role. For that requirement, create an application-owned approval request row, notify eligible approvers through a channel, and let the original tool poll or resume only after that row records an authorized decision.

## Production checks

- Default to deny when the tenant, membership, policy row, or policy database is unavailable.
- Recheck authorization inside `execute`; inputs and membership can change while a run is parked.
- Protect session create/continue/stream routes with tenant ownership checks.
- Keep connection allow-lists narrow even when approval is enabled.
- Use idempotency keys for side effects; approval alone is not a transaction boundary.
- Audit policy evaluations and the eventual human response without logging secrets or unnecessary tool input.
- Decide explicitly how schedules behave. Task-mode schedules cannot wait for a human, and this evaluator denies sessions without one pinned tenant user.
- Test two tenants with different rows for the same tool name, plus missing-policy, inactive-member, role, threshold, and cross-tenant cases.

The result is tenant-specific governance built entirely from eve's existing primitives: authenticated session context, async approval callbacks, connection tool names, durable pause/resume, and normal authored code.
