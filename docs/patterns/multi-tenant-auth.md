---
title: "Multi-tenant outbound auth"
description: "Select tenant-scoped credentials inside authored tools, OpenAPI connections, and MCP connections from the active turn context."
---

eve authenticates inbound callers at the channel and carries that identity into `ctx.session.auth`. Authored tools and connections can then select outbound credentials for the current tenant. This is application-level multi-tenancy: eve provides the context and async resolver hooks, while your identity system, membership database, and credential vault remain authoritative.

This example covers all three outbound surfaces:

- an authored tool that calls an HTTP API directly;
- an OpenAPI connection with an async `auth(ctx)` resolver and async headers;
- an MCP connection with the same tenant-bound bearer and routing headers.

At no point does the model supply a tenant id, token, API key, or workspace header.

## 1. Put the tenant on verified route auth

The example expects an OIDC token with a string `tenantId` claim. `oidc()` verifies the signature, issuer, audience, time bounds, and subject, then exposes non-standard string claims through `auth.attributes`.

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { ForbiddenError, oidc, type AuthFn } from "eve/channels/auth";

const verifyIdentity = oidc({
  issuer: "https://identity.example.com",
  discoveryUrl: "https://identity.example.com/.well-known/openid-configuration",
  audiences: ["eve-agent"],
});

const tenantIdentity: AuthFn<Request> = async (request) => {
  const auth = await verifyIdentity(request);
  if (!auth) return null;

  const tenantId = auth.attributes.tenantId;
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new ForbiddenError({ message: "The identity has no tenant assignment." });
  }
  return auth;
};

export default eveChannel({ auth: tenantIdentity });
```

Use the claim name your identity provider actually issues. If your browser app uses its own session cookie, implement an `AuthFn<Request>` that verifies that session and returns the same shape instead.

Centralize the runtime check:

```ts title="agent/lib/tenant.ts"
import type { SessionContext } from "eve/context";

export interface TenantCaller {
  tenantId: string;
  userId: string;
}

export function requireTenantCaller(ctx: SessionContext): TenantCaller {
  const caller = ctx.session.auth.current;
  const tenantId = caller?.attributes.tenantId;

  if (caller?.principalType !== "user" || typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("An authenticated tenant user is required.");
  }
  return { tenantId, userId: caller.principalId };
}
```

## 2. Store credentials outside the agent definition

Production credentials belong in a secret manager or encrypted database, not in instructions, tool inputs, source files, or conversation history. The following complete PostgreSQL adapter encrypts each secret with AES-256-GCM. In a larger system, replace it with your cloud secret manager while preserving the `getTenantCredential(tenantId, service)` boundary.

```sql title="db/migrations/003_tenant_credentials.sql"
CREATE TABLE tenant_credentials (
  tenant_id text NOT NULL,
  service text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bearer', 'api-key')),
  secret_ciphertext text NOT NULL,
  external_tenant_id text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service)
);

REVOKE ALL ON tenant_credentials FROM PUBLIC;
```

Install the database client and configure `DATABASE_URL` plus a random 32-byte base64 key in `TENANT_CREDENTIAL_KEY`:

```sh
pnpm add postgres
openssl rand -base64 32
```

```ts title="agent/lib/db.ts"
import postgres from "postgres";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
export const sql = postgres(process.env.DATABASE_URL, { max: 5, prepare: false });
```

```ts title="agent/lib/credential-store.ts"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { sql } from "./db.js";

export type CredentialKind = "api-key" | "bearer";

export interface TenantCredential {
  kind: CredentialKind;
  secret: string;
  externalTenantId: string;
  expiresAt?: number;
}

function encryptionKey(): Buffer {
  const value = process.env.TENANT_CREDENTIAL_KEY;
  if (!value) throw new Error("TENANT_CREDENTIAL_KEY is required.");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("TENANT_CREDENTIAL_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptSecret(value: string): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) {
    throw new Error("Unsupported tenant credential ciphertext.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

// Call this from your trusted control plane, never from a model-facing tool.
export async function putTenantCredential(input: {
  tenantId: string;
  service: string;
  kind: CredentialKind;
  secret: string;
  externalTenantId: string;
  expiresAt?: Date;
}): Promise<void> {
  await sql`
    INSERT INTO tenant_credentials (
      tenant_id, service, kind, secret_ciphertext, external_tenant_id, expires_at
    ) VALUES (
      ${input.tenantId}, ${input.service}, ${input.kind},
      ${encryptSecret(input.secret)}, ${input.externalTenantId},
      ${input.expiresAt ?? null}
    )
    ON CONFLICT (tenant_id, service)
    DO UPDATE SET kind = EXCLUDED.kind,
      secret_ciphertext = EXCLUDED.secret_ciphertext,
      external_tenant_id = EXCLUDED.external_tenant_id,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
  `;
}

export async function getTenantCredential(
  tenantId: string,
  service: string,
): Promise<TenantCredential> {
  const [row] = await sql<
    {
      kind: CredentialKind;
      secret_ciphertext: string;
      external_tenant_id: string;
      expires_at: Date | null;
    }[]
  >`
    SELECT kind, secret_ciphertext, external_tenant_id, expires_at
    FROM tenant_credentials
    WHERE tenant_id = ${tenantId} AND service = ${service}
  `;
  if (!row) throw new Error(`Service ${service} is not connected for this tenant.`);

  return {
    kind: row.kind,
    secret: decryptSecret(row.secret_ciphertext),
    externalTenantId: row.external_tenant_id,
    ...(row.expires_at ? { expiresAt: row.expires_at.getTime() } : {}),
  };
}
```

Keep `putTenantCredential` in an admin-only application process if possible. It is shown beside the reader so the ciphertext format and rotation path are complete; it should not be imported by the agent's tools.

## 3. Authenticate an authored tool call

An authored tool gets `ctx` in `execute`. Derive the tenant, resolve its credential, and construct the outbound request there:

```ts title="agent/tools/list_invoices.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { getTenantCredential } from "../lib/credential-store.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineTool({
  description: "List recent invoices from the current tenant's billing account.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
  async execute({ limit }, ctx) {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await getTenantCredential(tenantId, "billing");
    if (credential.kind !== "bearer") {
      throw new Error("The billing credential must be a bearer token.");
    }

    const response = await fetch(`https://billing.example.com/v1/invoices?limit=${limit}`, {
      headers: {
        authorization: `Bearer ${credential.secret}`,
        "x-account-id": credential.externalTenantId,
      },
    });
    if (!response.ok) {
      throw new Error(`Billing API returned ${response.status}.`);
    }
    return await response.json();
  },
});
```

The tool schema contains only business input. Even if a prompt says “use tenant B,” the executor derives tenant A from verified context.

## 4. Authenticate an OpenAPI connection

Both `auth` and `headers` may be async functions of the active turn context. Use `auth` for the bearer and `headers` for tenant routing metadata:

```ts title="agent/connections/billing.ts"
import { defineOpenAPIConnection } from "eve/connections";
import { getTenantCredential } from "../lib/credential-store.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineOpenAPIConnection({
  spec: "https://billing.example.com/openapi.json",
  description: "Invoices and subscriptions for the current tenant.",
  operations: { allow: ["listInvoices", "getInvoice", "updateSubscription"] },

  auth: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await getTenantCredential(tenantId, "billing");
    if (credential.kind !== "bearer") {
      throw new Error("The billing credential must be a bearer token.");
    }
    return {
      principalType: "user",
      getToken: async () => ({
        token: credential.secret,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      }),
    };
  },

  headers: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await getTenantCredential(tenantId, "billing");
    return { "X-Account-Id": credential.externalTenantId };
  },
});
```

`principalType: "user"` makes eve require an authenticated user and keys its scoped token handling to that principal. The resolver still selects the tenant credential explicitly. If every user has an individual OAuth grant instead, store by `(tenant_id, user_id, service)` and include `userId` in `getTenantCredential`.

Do not add an `Authorization` header in `headers` when `auth` is also present; eve constructs the bearer header from `getToken` and rejects conflicting definitions.

## 5. Authenticate an MCP connection

MCP uses the same resolver contracts. This server takes a bearer token and a workspace-routing header:

```ts title="agent/connections/support.ts"
import { defineMcpClientConnection } from "eve/connections";
import { getTenantCredential } from "../lib/credential-store.js";
import { requireTenantCaller } from "../lib/tenant.js";

export default defineMcpClientConnection({
  url: "https://support.example.com/mcp",
  description: "Support tickets and customers for the current tenant.",
  tools: { allow: ["search_tickets", "get_ticket", "add_internal_note"] },

  auth: async (ctx) => {
    const { tenantId } = requireTenantCaller(ctx);
    const credential = await getTenantCredential(tenantId, "support");
    if (credential.kind !== "bearer") {
      throw new Error("The support credential must be a bearer token.");
    }
    return {
      principalType: "user",
      getToken: async () => ({
        token: credential.secret,
        ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      }),
    };
  },

  headers: {
    "X-Workspace-Id": async (ctx) => {
      const { tenantId } = requireTenantCaller(ctx);
      const credential = await getTenantCredential(tenantId, "support");
      return credential.externalTenantId;
    },
  },
});
```

The whole-map async header form and per-header async form are equivalent. Use the whole-map form when values come from one lookup; use individual callbacks when headers have independent sources.

For an API-key-only MCP server, omit `auth` and return the secret from `headers`:

```ts
import type { HeadersDefinition } from "eve/connections";

const apiKeyHeaders: HeadersDefinition = async (ctx) => {
  const { tenantId } = requireTenantCaller(ctx);
  const credential = await getTenantCredential(tenantId, "support");
  if (credential.kind !== "api-key") throw new Error("Expected an API key.");
  return {
    "X-Api-Key": credential.secret,
    "X-Workspace-Id": credential.externalTenantId,
  };
};
```

Pass that function as `headers: apiKeyHeaders` on the MCP definition.

## Why the boundary is safe

1. Route auth verifies the caller and stamps `tenantId` onto the session.
2. `ctx.session.auth.current` identifies the caller for the active turn.
3. The credential lookup requires that verified tenant id.
4. The resolver returns headers or a token directly to eve's connection transport.
5. Credentials never become model messages or tool results.

This protects credential selection, but outbound authorization still depends on the remote service. Prefer a tenant-scoped credential that can access only its own account; treat `X-Account-Id` or `X-Workspace-Id` as routing, not as an authorization boundary.

## Production checks

- Enforce session ownership on create, continue, and stream routes; route authentication alone does not add tenant ACLs to session ids.
- Reject missing, array-valued, or malformed tenant claims.
- Keep credentials least-privileged, encrypted, rotatable, and excluded from logs and errors.
- Recheck tenant membership when your identity token can outlive a membership change.
- Allow-list OpenAPI operations and MCP tools; auth does not make every remote action safe.
- Add tests with two tenant credentials and assert every surface sends the correct bearer and routing header.
- Use approval for sensitive writes, as shown in the next example.

No framework-native tenant object is involved. These guarantees come from composing route auth, `ctx.session`, async connection resolvers, tool executors, and an application-owned vault.
