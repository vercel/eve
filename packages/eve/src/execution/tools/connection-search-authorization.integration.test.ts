import { describe, expect, it, vi } from "vitest";

import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { resolveConnectionSearchDynamicTools } from "#execution/tools/connection-search.js";
import { CallbackBaseUrlKey, isAuthorizationSignal } from "#harness/authorization.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import type { ToolContext } from "#tools/definition.js";
import type { DynamicToolSet } from "#tools/dynamic.js";

function setup() {
  const getToken = vi.fn(async () => {
    throw new ConnectionAuthorizationRequiredError("private-catalog");
  });
  const startAuthorization = vi.fn(async () => ({
    challenge: { url: "https://identity.example/authorize" },
  }));
  const privateCatalog: ResolvedConnectionDefinition = {
    connectionName: "private-catalog",
    description: "Private catalog",
    logicalPath: "agent/connections/private-catalog.ts",
    sourceId: "connections/private-catalog",
    sourceKind: "module",
    protocol: "mcp",
    url: "https://private.example/mcp",
    authorization: {
      principalType: "user",
      getToken,
      startAuthorization,
      completeAuthorization: async () => ({ token: "fixture-token" }),
    },
  };
  const publicCatalog: ResolvedConnectionDefinition = {
    ...privateCatalog,
    connectionName: "public-catalog",
    description: "Public catalog",
    authorization: undefined,
    protocol: "openapi",
    spec: {
      openapi: "3.0.0",
      info: { title: "Public catalog", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "list_items",
            summary: "List catalog items",
            responses: { "200": { description: "Catalog items" } },
          },
        },
      },
    },
  };
  const registry = new ConnectionRegistryImpl([privateCatalog, publicCatalog]);
  const context = new ContextContainer();
  context.set(ConnectionRegistryKey, registry);
  context.set(SessionIdKey, "catalog-session");
  context.set(CallbackBaseUrlKey, "https://agent.example");
  context.set(AuthKey, {
    attributes: {},
    authenticator: "fixture",
    issuer: "fixture",
    principalId: "alice",
    principalType: "user",
  });

  async function search(connection?: string) {
    return contextStorage.run(context, async () => {
      const tools = (await resolveConnectionSearchDynamicTools()) as DynamicToolSet;
      return tools.connection_search!.execute({ connection, keywords: "items" }, {} as ToolContext);
    });
  }

  return { context, getToken, registry, search, startAuthorization };
}

describe("connection search callback availability", () => {
  it("starts authorization when session identity and callback origin are present", async () => {
    const state = setup();
    try {
      expect(isAuthorizationSignal(await state.search("private-catalog"))).toBe(true);
      expect(state.getToken).toHaveBeenCalledOnce();
      expect(state.startAuthorization).toHaveBeenCalledOnce();
    } finally {
      await state.registry.dispose();
    }
  });

  // Characterize the PR's stricter policy. Main returned needsAuthorization instead.
  // The real MCP client asks the provider for a token before making any HTTP request.
  for (const missing of ["session", "origin", "both"] as const) {
    it(`fails a private-only search when ${missing} is missing`, async () => {
      const state = setup();
      if (missing !== "origin") state.context.delete(SessionIdKey);
      if (missing !== "session") state.context.delete(CallbackBaseUrlKey);

      try {
        await expect(state.search("private-catalog")).rejects.toThrow(
          "no authorization callback URL could be minted",
        );
        expect(state.getToken).toHaveBeenCalledOnce();
        expect(state.startAuthorization).not.toHaveBeenCalled();
      } finally {
        await state.registry.dispose();
      }
    });
  }

  it("keeps public tools discoverable alongside the private connection's callback error", async () => {
    const state = setup();
    state.context.delete(CallbackBaseUrlKey);

    try {
      const result = await state.search();
      expect(result).toEqual([
        expect.objectContaining({ qualifiedName: "public-catalog__list_items" }),
        {
          connection: "private-catalog",
          description: "Private catalog",
          error: expect.stringContaining("no authorization callback URL could be minted"),
        },
      ]);
      expect(state.getToken).toHaveBeenCalledOnce();
      expect(state.startAuthorization).not.toHaveBeenCalled();
    } finally {
      await state.registry.dispose();
    }
  });
});
