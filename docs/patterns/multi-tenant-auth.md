---
title: "Multi-Tenant Outbound Auth"
description: "Select tenant-scoped credentials inside authored tools, OpenAPI connections, and MCP connections from the active turn context."
---

Multi-tenant outbound auth picks the current tenant's credentials from the signed-in caller that eve passes into every turn:

- A tool's `execute` receives `ctx` directly.
- OpenAPI and MCP `auth` can be an async function of `ctx`.
- Connection `headers` can be an async function that returns a map, or a map of async values.

Your application stores tenant membership and credentials. The model never sees or chooses those credentials.

## Establish the tenant scope

Configure route auth so the accepted caller has a string `tenantId` attribute. Then put the check in one helper:

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
the caller before eve starts a run, then add the tenant to the session:

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

`verifyAgentCaller` is application code that validates an API key, verifies a
JWT, or reads an app session. It must return only after confirming that the user
belongs to the tenant they claim.

- Keep `principalId` stable for the same user.
- Include an `issuer` when ids can come from more than one identity system.
- Put routing values such as `tenantId` in `attributes`.

If one user can switch between orgs, authenticate the selected org on every
request that creates or continues a session. Set the selected `tenantId` on
the current turn.

This is not connection OAuth. The user is already signed in to your app, and
eve uses that user to pick the outbound credential.

## Build tenant connection auth

For Bearer tokens or JWTs for one tenant, write one auth helper that never
prompts the user to sign in. Use it for OpenAPI and MCP connections. With
`principalType: "user"`, eve requires a signed-in user from route auth and
passes that user to `getToken` as `principal`. eve never reuses a token
fetched for one user for another user:

```ts title="agent/lib/tenant-connection-auth.ts"
import type { AuthorizationDefinition, ConnectionPrincipal } from "eve/connections";
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

export function tenantBearerAuth(service: TenantService): AuthorizationDefinition {
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
service uses one credential for all users in a tenant, look it up by
`tenantId` in your provider. Connection auth with `principalType: "user"` still
rejects sessions without a signed-in user, and it never gives one caller's
token to another caller.

## Authenticate an authored tool call

Read the tenant inside `execute`, get its credential from your provider, and build the outbound request:

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

The model controls only `limit`. Even if a prompt asks for another tenant, `execute` picks the credential from `ctx.session.auth.current`.

## Authenticate an OpenAPI connection

Attach the auth helper to the connection. Generated operation tools receive
the token at call time without exposing it to the model:

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

Do not return `Authorization` from `headers` when `auth` is present. eve builds that header from `getToken` and rejects definitions that set both.

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

Use the same shape for OpenAPI connections. eve sends API keys from `headers`
only on outbound requests. They are not model inputs or tool results.

## Supply the credential provider

The tools and connections need only this interface:

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

Implement the provider with the secret system your application already trusts.
Examples are a cloud secret manager, an encrypted database table, a token broker,
or an out-of-band OAuth flow you own.

The provider must fail closed for unknown tenants, keep secrets out of logs and errors, and rotate or refresh credentials before `expiresAt`. Prefer credentials that are themselves restricted to one remote tenant. Treat workspace headers as routing, not authorization.

## What the model can and cannot see

1. Route auth adds the verified tenant to the session.
2. Tool code reads `ctx.session.auth.current`, and connection auth receives the user as `principal`.
3. Your provider gets the matching credential.
4. eve sends the resulting token and headers directly to the remote service.
5. Neither becomes a model message or tool result.

Also check which tenant a session belongs to on the session create, continue, and stream routes. Route authentication identifies the caller. Your application's access list decides which session IDs that caller may access.
