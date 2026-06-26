---
title: "Multi-tenant outbound auth"
description: "Select tenant-scoped credentials inside authored tools, OpenAPI connections, and MCP connections from the active turn context."
---

eve carries verified inbound identity into every turn. Authored tools and connections can use that context to select outbound credentials for the current tenant:

- tool executors receive `ctx` directly;
- OpenAPI and MCP `auth` may be async functions of `ctx`;
- connection headers may be an async map or async individual values.

That is the entire pattern. Your application still owns tenant membership and credential storage; eve ensures the model never needs to see or choose those credentials.

## Establish the tenant scope

Configure route auth so the accepted principal contains a string `tenantId` attribute. Then centralize the runtime check:

```ts title="agent/lib/tenant.ts"
import type { SessionContext } from "eve/context";

export function requireTenantCaller(ctx: SessionContext): {
  tenantId: string;
  userId: string;
} {
  const caller = ctx.session.auth.current;
  const tenantId = caller?.attributes.tenantId;

  if (caller?.principalType !== "user" || typeof tenantId !== "string") {
    throw new Error("An authenticated tenant user is required.");
  }

  return { tenantId, userId: caller.principalId };
}
```

The tenant comes from verified route auth, never a prompt, tool argument, or remote API response. See [Auth & route protection](../guides/auth-and-route-protection) for custom session and OIDC examples.

## Authenticate an authored tool call

Derive the tenant inside `execute`, fetch its credential from your application provider, and construct the outbound request:

```ts title="agent/tools/list_invoices.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { tenantCredentials } from "../lib/tenant-credentials.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineTool({
  description: "List recent invoices from the current tenant's billing account.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  async execute({ limit }, ctx) {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.get(tenantId, "billing");

    const response = await fetch(`https://billing.example.com/v1/invoices?limit=${limit}`, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        "x-account-id": credential.externalTenantId,
      },
    });
    if (!response.ok) throw new Error(`Billing API returned ${response.status}.`);
    return await response.json();
  },
});
```

The model controls only `limit`. Even if a prompt asks for another tenant, the executor selects the credential from `ctx.session.auth.current`.

## Authenticate an OpenAPI connection

An async `auth(ctx)` resolver can select a tenant bearer without exposing it to generated tools:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { tenantCredentials } from "../lib/tenant-credentials.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineOpenAPIConnection({
  spec: "https://billing.example.com/openapi.json",
  description: "Invoices and subscriptions for the current tenant.",
  operations: { allow: ["listInvoices", "getInvoice", "updateSubscription"] },

  auth: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.get(tenantId, "billing");
    return {
      principalType: "user",
      getToken: async () => ({
        token: credential.token,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      }),
    };
  },

  headers: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.get(tenantId, "billing");
    return { "X-Account-Id": credential.externalTenantId };
  },
});
```

`principalType: "user"` requires an authenticated user and keeps eve's step-local token handling scoped to that principal. If credentials are per user rather than shared by a tenant, include `userId` in your provider lookup.

Do not return `Authorization` from `headers` when `auth` is present. eve constructs that header from `getToken` and rejects conflicting definitions.

## Authenticate an MCP connection

MCP connections accept the same callbacks:

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { tenantCredentials } from "../lib/tenant-credentials.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets and customers for the current tenant.",
  tools: { allow: ["search_tickets", "get_ticket", "add_internal_note"] },

  auth: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.get(tenantId, "support");
    return {
      principalType: "user",
      getToken: async () => ({
        token: credential.token,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      }),
    };
  },

  headers: {
    "X-Workspace-Id": async (ctx) => {
      const { tenantId } = requireTenantCaller(ctx);
      const credential = await tenantCredentials.get(tenantId, "support");
      return credential.externalTenantId;
    },
  },
});
```

For an API-key-only server, omit `auth` and return both the key and routing metadata from the async `headers` callback instead.

## Supply the credential provider

The eve-facing files need only this application contract:

```ts title="agent/lib/tenant-credentials.ts"
export interface TenantCredential {
  token: string;
  externalTenantId: string;
  expiresAt?: number;
}

export interface TenantCredentialProvider {
  get(tenantId: string, service: "billing" | "support"): Promise<TenantCredential>;
}

export { tenantCredentials } from "../../lib/tenant-credentials.js";
```

Implement the provider with the secret system your application already trusts: a cloud secret manager, an encrypted database table, a token broker, or per-user OAuth. eve does not prescribe that choice.

The provider must fail closed for unknown tenants, avoid returning secrets in logs or errors, and rotate or refresh credentials before `expiresAt`. Prefer credentials that are themselves restricted to one remote tenant; treat workspace headers as routing, not authorization.

## What the model can and cannot see

1. Route auth stamps the verified tenant onto the session.
2. The callback reads `ctx.session.auth.current` inside the active turn.
3. The application provider resolves the corresponding credential.
4. eve sends the resulting token and headers directly to the remote service.
5. Neither becomes a model message or tool result.

Also enforce tenant ownership for session create, continue, and stream routes. Route authentication identifies the caller, but your application owns the ACL that decides which session ids that caller may access.

No framework-native tenant object is involved. The implementation is the composition of route auth, `ctx.session`, tool execution, and async connection auth/header resolvers.
