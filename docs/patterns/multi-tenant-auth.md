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

## Authenticate with your own API key or JWT

For production apps with many customer orgs, the inbound credential is often
your own API key, session cookie, or JWT. Use that credential to authenticate
the caller before eve starts a run, then stamp the tenant onto the session:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { localDev, type AuthFn } from "eve/channels/auth";
import { verifyAgentCaller } from "../../lib/app-auth";

function tenantAppAuth(): AuthFn<Request> {
  return async (request) => {
    const caller = await verifyAgentCaller(request);
    if (caller === null) return null;

    return {
      authenticator: "app",
      issuer: "https://app.example.com",
      principalId: caller.userId,
      principalType: "user",
      subject: caller.userId,
      attributes: {
        tenantId: caller.tenantId,
        roles: caller.roles,
      },
    };
  };
}

export default eveChannel({
  auth: [tenantAppAuth(), localDev()],
});
```

`verifyAgentCaller` is application code. It can validate an API key, verify a
JWT, or read an app session, but it should return only after the user belongs
to the tenant they are claiming. Keep `principalId` stable for the same user,
include an `issuer` when ids can come from more than one identity system, and
put routing facts such as `tenantId` in `attributes`.

If one user can switch between orgs, authenticate the selected org on every
session create or continue request and stamp that selected `tenantId` onto the
current turn.

This is not connection OAuth. The user is already authenticated to your app;
eve uses that verified principal to pick the correct outbound credential.

## Build tenant connection auth

For Bearer tokens or tenant-scoped JWTs, write one non-interactive auth helper
and reuse it across OpenAPI and MCP connections. `principalType: "user"` tells
eve to require the authenticated user from route auth, key the step-local token
cache by that user, and pass the projected principal into `getToken`:

```ts title="agent/lib/tenant-connection-auth.ts"
import type { ConnectionPrincipal, NonInteractiveAuthorizationDefinition } from "eve/connections";
import { tenantCredentials, type TenantService } from "./tenant-credentials";

function requireTenantPrincipal(principal: ConnectionPrincipal): {
  tenantId: string;
  userId: string;
} {
  const tenantId = principal.type === "user" ? principal.attributes?.tenantId : undefined;

  if (principal.type !== "user" || typeof tenantId !== "string") {
    throw new Error("An authenticated tenant user is required.");
  }

  return { tenantId, userId: principal.id };
}

export function tenantBearerAuth(service: TenantService): NonInteractiveAuthorizationDefinition {
  return {
    principalType: "user",
    async getToken({ principal }) {
      const { tenantId, userId } = requireTenantPrincipal(principal);
      const credential = await tenantCredentials.getBearer(tenantId, service, { userId });

      return {
        token: credential.bearerToken,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      };
    },
  };
}
```

The model never supplies `tenantId` or sees the returned token. If the remote
service uses tenant-level credentials shared by multiple users, keep the
credential lookup keyed by `tenantId` in your provider; user-scoped connection
auth is still useful because it rejects unauthenticated sessions and keeps
eve's token cache from crossing caller identities.

## Authenticate an authored tool call

Derive the tenant inside `execute`, fetch its credential from your application provider, and construct the outbound request:

```ts title="agent/tools/list_invoices.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { tenantCredentials } from "../lib/tenant-credentials";
import { requireTenantCaller } from "../lib/tenant";

export default defineTool({
  description: "List recent invoices from the current tenant's billing account.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  async execute({ limit }, ctx) {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.getBearer(tenantId, "billing");

    const response = await fetch(`https://billing.example.com/v1/invoices?limit=${limit}`, {
      headers: {
        authorization: `Bearer ${credential.bearerToken}`,
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

Attach the reusable auth helper to the connection. Generated operation tools
receive the token at call time without exposing it to the model:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { tenantCredentials } from "../lib/tenant-credentials";
import { tenantBearerAuth } from "../lib/tenant-connection-auth";
import { requireTenantCaller } from "../lib/tenant";

export default defineOpenAPIConnection({
  spec: "https://billing.example.com/openapi.json",
  description: "Invoices and subscriptions for the current tenant.",
  operations: { allow: ["listInvoices", "getInvoice", "updateSubscription"] },
  auth: tenantBearerAuth("billing"),

  headers: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.getBearer(tenantId, "billing");
    return { "X-Account-Id": credential.externalTenantId };
  },
});
```

Do not return `Authorization` from `headers` when `auth` is present. eve constructs that header from `getToken` and rejects conflicting definitions.

## Authenticate an MCP connection

MCP connections accept the same callbacks:

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { tenantCredentials } from "../lib/tenant-credentials";
import { tenantBearerAuth } from "../lib/tenant-connection-auth";
import { requireTenantCaller } from "../lib/tenant";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets and customers for the current tenant.",
  tools: { allow: ["search_tickets", "get_ticket", "add_internal_note"] },
  auth: tenantBearerAuth("support"),

  headers: {
    "X-Workspace-Id": async (ctx) => {
      const { tenantId } = requireTenantCaller(ctx);
      const credential = await tenantCredentials.getBearer(tenantId, "support");
      return credential.externalTenantId;
    },
  },
});
```

## Authenticate an API-key-only connection

If the remote server does not accept Bearer auth, omit `auth` and return the
tenant API key from `headers` instead:

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { tenantCredentials } from "../lib/tenant-credentials";
import { requireTenantCaller } from "../lib/tenant";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets and customers for the current tenant.",
  tools: { allow: ["search_tickets", "get_ticket", "add_internal_note"] },

  headers: async (ctx) => {
    const { tenantId, userId } = requireTenantCaller(ctx);
    const credential = await tenantCredentials.getApiKey(tenantId, "support", { userId });

    return {
      "X-Api-Key": credential.apiKey,
      "X-Workspace-Id": credential.externalTenantId,
    };
  },
});
```

Use the same shape for OpenAPI connections. API keys resolved in `headers` are
sent only on outbound requests; they are not model inputs or tool results.

## Supply the credential provider

The eve-facing files need only this application contract:

```ts title="agent/lib/tenant-credentials.ts"
export type TenantService = "billing" | "support";

export interface TenantBearerCredential {
  bearerToken: string;
  externalTenantId: string;
  expiresAt?: number;
}

export interface TenantApiKeyCredential {
  apiKey: string;
  externalTenantId: string;
}

export interface TenantCredentialProvider {
  getBearer(
    tenantId: string,
    service: TenantService,
    options?: { userId?: string },
  ): Promise<TenantBearerCredential>;
  getApiKey(
    tenantId: string,
    service: TenantService,
    options?: { userId?: string },
  ): Promise<TenantApiKeyCredential>;
}

export { tenantCredentials } from "../../lib/tenant-credentials";
```

Implement the provider with the secret system your application already trusts:
a cloud secret manager, an encrypted database table, a token broker, or an
out-of-band OAuth flow you own. eve does not prescribe that choice.

The provider must fail closed for unknown tenants, avoid returning secrets in logs or errors, and rotate or refresh credentials before `expiresAt`. Prefer credentials that are themselves restricted to one remote tenant; treat workspace headers as routing, not authorization.

## What the model can and cannot see

1. Route auth stamps the verified tenant onto the session.
2. Tool code reads `ctx.session.auth.current`, and connection auth receives the projected `principal`.
3. The application provider resolves the corresponding credential.
4. eve sends the resulting token and headers directly to the remote service.
5. Neither becomes a model message or tool result.

Also enforce tenant ownership for session create, continue, and stream routes. Route authentication identifies the caller, but your application owns the ACL that decides which session ids that caller may access.

No framework-native tenant object is involved. The implementation is the composition of route auth, `ctx.session`, tool execution, and async connection auth/header resolvers.
