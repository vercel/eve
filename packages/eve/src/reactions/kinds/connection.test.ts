import { describe, expect, it } from "vitest";

import { defineMcpClientConnection } from "#public/definitions/connections/mcp.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import {
  beforeModelCall,
  evaluationError,
  reactionSession,
} from "#internal/testing/reaction-session.js";
import { ParentSessionKey } from "#context/keys.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { resolveApprovalPolicy } from "#approval/definition.js";

const mcp = (url: string, extra: object = {}) =>
  defineMcpClientConnection({ description: "Linear.", url, ...extra });

const names = (registry: { getConnections(): readonly ResolvedConnectionDefinition[] }) =>
  registry.getConnections().map(({ connectionName }) => connectionName);

describe("dynamic connections", () => {
  it.each([
    [
      "names one connection after its file",
      undefined,
      () => mcp("https://linear.example"),
      ["linear"],
    ],
    [
      "names a map's connections after their keys",
      undefined,
      () => ({
        catalog: defineOpenAPIConnection({
          baseUrl: "https://catalog.example",
          description: "Product catalog.",
          spec: { info: { title: "Catalog", version: "1" }, openapi: "3.0.0", paths: {} },
        }),
        production: mcp("https://linear.example/production"),
      }),
      ["catalog", "production"],
    ],
    [
      "prefixes an extension's map keys with its namespace",
      "tracker",
      () => ({ issues: mcp("https://linear.example") }),
      ["tracker__issues"],
    ],
  ])("%s", async (_name, extensionNamespace, evaluate, expected) => {
    const { ctx, registry } = reactionSession({
      connections: [{ evaluate, extensionNamespace, slug: "linear" }],
    });
    await beforeModelCall(ctx);
    expect(names(registry)).toEqual(expected);
  });

  it("reads the delegating session's lineage, and none in a root session", async () => {
    const parent = {
      callId: "call-child",
      rootSessionId: "root",
      sessionId: "child",
      turn: { id: "turn-child", sequence: 1 },
    };
    const seen: unknown[] = [];
    const evaluate = (ctx: { readonly session: { readonly parent?: unknown } }) => {
      seen.push(ctx.session.parent);
      return null;
    };
    const delegated = reactionSession({ connections: [{ evaluate, slug: "linear" }] });
    delegated.ctx.set(ParentSessionKey, parent);
    await beforeModelCall(delegated.ctx);
    const root = reactionSession({ connections: [{ evaluate, slug: "linear" }] });
    await beforeModelCall(root.ctx);

    expect(seen).toEqual([parent, undefined]);
  });

  it("refreshes a dynamic connection's policy even when its target is unchanged", async () => {
    let requiresReview = false;
    const staticLinear = { connectionName: "linear", url: "https://static.example" } as never;
    const { ctx, registry } = reactionSession({
      connections: [
        {
          evaluate: () => {
            const review = requiresReview;
            return mcp("https://dynamic.example", {
              approval: () => (review ? "user-approval" : "not-applicable"),
            });
          },
          slug: "linear",
        },
      ],
      staticConnections: [staticLinear],
    });
    await beforeModelCall(ctx);
    expect(
      await resolveApprovalPolicy(registry.getConnectionApproval("linear")!)({} as never),
    ).toBe("not-applicable");
    requiresReview = true;
    await beforeModelCall(ctx);
    expect(registry.getConnections().map(({ url }) => url)).toEqual(["https://dynamic.example"]);
    expect(
      await resolveApprovalPolicy(registry.getConnectionApproval("linear")!)({} as never),
    ).toBe("user-approval");
  });

  it("gives authenticated connections an opaque identity from their instance key", async () => {
    let tenant = "acme";
    const { ctx, registry } = reactionSession({
      connections: [
        {
          evaluate: () =>
            mcp("https://linear.example", {
              auth: { getToken: async () => "token" },
              instanceKey: tenant,
            }),
          slug: "linear",
        },
      ],
    });
    await beforeModelCall(ctx);
    const acme = registry.getConnections()[0]?.instanceId;
    tenant = "globex";
    await beforeModelCall(ctx);

    expect(acme).toEqual(expect.any(String));
    expect(acme).not.toContain("acme");
    expect(registry.getConnections()[0]?.instanceId).not.toBe(acme);
  });

  it.each([
    [
      "an authenticated connection without an instance key",
      () => mcp("https://linear.example", { auth: { getToken: async () => "token" } }),
      {},
      'must set "instanceKey"',
    ],
    [
      "an unbranded value",
      () => ({ linear: { url: "https://linear.example" } }),
      {},
      'returned "linear" without defineMcpClientConnection()',
    ],
    [
      "an illegal map key",
      () => ({ Linear: mcp("https://linear.example") }),
      {},
      'illegal connection name "Linear"',
    ],
    [
      "eve's namespace",
      () => ({ eve: mcp("https://linear.example") }),
      {},
      'reserved connection name "eve"',
    ],
    [
      "a name that owns an authored tool",
      () => mcp("https://linear.example"),
      { toolNames: ["linear__search"] },
      'Tool or subagent "linear__search" starts with "linear__"',
    ],
  ])("rejects %s", async (_name, evaluate, session, message) => {
    const { ctx } = reactionSession({ ...session, connections: [{ evaluate, slug: "linear" }] });
    expect(await evaluationError(ctx)).toContain(message);
  });

  it("rejects a connection nested under another connection's name", async () => {
    const { ctx } = reactionSession({
      connections: [
        {
          evaluate: () => ({ issues: mcp("https://linear.example") }),
          extensionNamespace: "tracker",
          slug: "linear",
        },
      ],
      staticConnections: [{ connectionName: "tracker", url: "https://tracker.example" } as never],
    });
    expect(await evaluationError(ctx)).toContain(
      `Connection "tracker__issues" starts with "tracker__"`,
    );
  });

  it("rejects two definitions that return the same connection name", async () => {
    const { ctx } = reactionSession({
      connections: [
        { evaluate: () => ({ linear: mcp("https://one.example") }), slug: "first" },
        { evaluate: () => ({ linear: mcp("https://two.example") }), slug: "second" },
      ],
    });
    expect(await evaluationError(ctx)).toContain('Dynamic connection "linear"');
  });
});
