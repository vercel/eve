import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { dispatchDynamicConnectionEvent } from "#context/dynamic-connection-lifecycle.js";
import { SessionIdKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { createSessionStartedEvent, createTurnStartedEvent } from "#protocol/message.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type {
  ResolvedConnectionDefinition,
  ResolvedDynamicConnectionResolver,
} from "#runtime/types.js";

describe("dynamic connection lifecycle", () => {
  it("resolves a mixed connection map with bare map-key names", async () => {
    const { ctx, registry } = createContext();
    const resolver = createResolver({
      handler: () => ({
        catalog: defineOpenAPIConnection({
          baseUrl: "https://catalog.example.com",
          description: "Product catalog.",
          spec: { info: { title: "Catalog", version: "1" }, openapi: "3.0.0", paths: {} },
        }),
        production: defineMcpClientConnection({
          description: "Production account.",
          url: "https://mcp.example.com/production",
        }),
      }),
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(registry.getConnections()).toMatchObject([
      {
        connectionName: "catalog",
        description: "Product catalog.",
        protocol: "openapi",
        url: "https://catalog.example.com",
      },
      {
        connectionName: "production",
        description: "Production account.",
        protocol: "mcp",
        url: "https://mcp.example.com/production",
      },
    ]);
  });

  it("names one returned connection after its file slug", async () => {
    const { ctx, registry } = createContext();
    const resolver = createResolver({
      handler: () =>
        defineMcpClientConnection({
          description: "Current account.",
          url: "https://mcp.example.com/current",
        }),
      slug: "aws",
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(registry.getConnectionNames()).toEqual(["aws"]);
  });

  it("lets a turn result replace the same resolver's session result", async () => {
    const { ctx, registry } = createContext();
    const resolver = createResolver({
      eventNames: ["session.started", "turn.started"],
      events: {
        "session.started": () => ({
          primary: defineMcpClientConnection({
            description: "Primary account.",
            url: "https://mcp.example.com/primary",
          }),
        }),
        "turn.started": () => null,
      },
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });
    expect(registry.getConnectionNames()).toEqual(["primary"]);

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }),
      messages: [],
      resolvers: [resolver],
    });
    expect(registry.getConnectionNames()).toEqual([]);
  });

  it("lets a dynamic result override a static connection by name", async () => {
    const staticConnection = createStaticConnection("production");
    const { ctx, registry } = createContext([staticConnection]);
    const resolver = createResolver({
      handler: () => ({
        production: defineMcpClientConnection({
          description: "Caller production account.",
          url: "https://dynamic.example.com/mcp",
        }),
      }),
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(registry.getConnections()).toMatchObject([
      { connectionName: "production", description: "Caller production account." },
    ]);
  });

  it("rejects collisions between effective dynamic resolvers", async () => {
    const { ctx } = createContext();
    const connection = () => ({
      shared: defineMcpClientConnection({
        description: "Shared account.",
        url: "https://mcp.example.com/shared",
      }),
    });

    await expect(
      dispatchDynamicConnectionEvent({
        ctx,
        event: createSessionStartedEvent(),
        messages: [],
        resolvers: [
          createResolver({ handler: connection, slug: "first" }),
          createResolver({ handler: connection, slug: "second" }),
        ],
      }),
    ).rejects.toThrow(
      'Dynamic connection "shared" from resolver "second" collides with dynamic resolver "first".',
    );
  });

  it("fails closed when a handler returns an unbranded connection", async () => {
    const { ctx, registry } = createContext();
    const resolver = createResolver({
      handler: () => ({
        unsafe: {
          description: "Unbranded.",
          url: "https://mcp.example.com/unsafe",
        },
      }),
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(registry.getConnections()).toEqual([]);
  });

  it("prefixes map keys produced by an extension resolver", async () => {
    const { ctx, registry } = createContext();
    const resolver = createResolver({
      extensionNamespace: "cloud",
      handler: () => ({
        production: defineMcpClientConnection({
          description: "Production account.",
          url: "https://mcp.example.com/production",
        }),
      }),
    });

    await dispatchDynamicConnectionEvent({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [resolver],
    });

    expect(registry.getConnectionNames()).toEqual(["cloud__production"]);
  });
});

function createContext(staticConnections: readonly ResolvedConnectionDefinition[] = []) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "session-1");
  const registry = new ConnectionRegistryImpl(staticConnections);
  ctx.set(ConnectionRegistryKey, registry);
  return { ctx, registry };
}

function createResolver(
  input: {
    readonly eventNames?: readonly string[];
    readonly events?: ResolvedDynamicConnectionResolver["events"];
    readonly extensionNamespace?: string;
    readonly handler?: () => unknown;
    readonly slug?: string;
  } = {},
): ResolvedDynamicConnectionResolver {
  const slug = input.slug ?? "accounts";
  return {
    eventNames: input.eventNames ?? ["session.started"],
    events: input.events ?? { "session.started": input.handler ?? (() => null) },
    extensionNamespace: input.extensionNamespace,
    logicalPath: `connections/${slug}.ts`,
    slug,
    sourceId: `connections/${slug}`,
    sourceKind: "module",
  };
}

function createStaticConnection(name: string): ResolvedConnectionDefinition {
  return {
    connectionName: name,
    description: "Static connection.",
    logicalPath: `connections/${name}.ts`,
    protocol: "mcp",
    sourceId: `connections/${name}`,
    sourceKind: "module",
    url: `https://${name}.example.com/mcp`,
  };
}
