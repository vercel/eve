import { describe, expect, it } from "vitest";

import {
  mergeEveVercelConfig,
  type EnsureEveVercelServicesConfigResult,
} from "./vercel-services.js";

function generatedAgents(
  names: readonly (string | undefined)[],
): Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }> {
  return {
    mode: "generated",
    agents: names.map((name) => ({
      agent: {
        appRoot: name === undefined ? "/app" : `/app/agents/${name}`,
        buildCommand: "eve build",
        name,
        publicRoutePrefix: name === undefined ? "" : `/eve/${name}`,
        workspaceMember: name !== undefined,
      },
      target: { hostOutputDirectory: "/app/.vercel/output", projectRoot: "/app" },
    })),
  };
}

const GENERATED = generatedAgents([undefined]);
const GENERATED_WORKSPACE = generatedAgents(["billing", "support"]);
const TRANSPORT_ROUTE = {
  destination: { service: "eve", type: "service" },
  src: "^/eve/v1/(.*)$",
};

describe("mergeEveVercelConfig", () => {
  it("builds an isolated service and transport route when nothing exists", () => {
    const config = mergeEveVercelConfig(undefined, GENERATED);
    expect(config.version).toBe(3);
    expect(config.routes).toEqual([TRANSPORT_ROUTE]);
    expect(config.services?.eve).toMatchObject({
      framework: "eve",
      root: ".eve/vercel-services/eve",
      routes: [
        {
          src: "^/eve/v1/(.*)$",
          transforms: [{ args: "/eve/v1/$1", op: "set", type: "request.path" }],
        },
      ],
    });
  });

  it("prepends the service route before user routes", () => {
    const userRoute = { src: "^/custom/(.*)$", dest: "/other/$1" };
    expect(mergeEveVercelConfig({ routes: [userRoute] }, GENERATED).routes).toEqual([
      TRANSPORT_ROUTE,
      userRoute,
    ]);
  });

  it.each([
    { label: "standalone", name: undefined, key: "agent", src: "^/eve/v1/(.*)$" },
    { label: "workspace", name: "support", key: "eve-support", src: "^/eve/support/v1/(.*)$" },
  ])("preserves authored $label service config and unrelated routes", ({ name, key, src }) => {
    const healthRoute = { src: "^/health$", dest: "/status" };
    const generated = generatedAgents([name]);
    const merged = mergeEveVercelConfig(
      {
        services: {
          [key]: {
            framework: "eve",
            root: "authored",
            buildCommand: "pnpm custom",
            routes: [healthRoute],
          },
          other: { framework: "hono" },
        },
        routes: [{ src: "^/custom$", dest: "/page" }, { handle: "filesystem" }],
      },
      generated,
    );
    expect(Object.keys(merged.services!)).toEqual([key, "other"]);
    expect(merged.services?.[key]).toMatchObject({
      framework: "eve",
      root: "authored",
      buildCommand: "pnpm custom",
    });
    expect(merged.services?.[key]?.routes).toEqual([
      { src, transforms: [{ args: "/eve/v1/$1", op: "set", type: "request.path" }] },
      healthRoute,
    ]);
    expect(merged.routes).toContainEqual({ src, destination: { service: key, type: "service" } });
    expect(merged.routes?.at(-1)).toEqual({ handle: "filesystem" });
    expect(mergeEveVercelConfig(merged, generated)).toEqual(merged);
  });

  it("inserts all workspace routes before filesystem routing and stays idempotent", () => {
    const before = { src: "^/a$", dest: "/b" };
    const after = { src: "^/c$", dest: "/d" };
    const once = mergeEveVercelConfig(
      { routes: [before, { handle: "filesystem" }, after] },
      GENERATED_WORKSPACE,
    );
    expect(once.routes).toEqual([
      before,
      { src: "^/eve/billing/v1/(.*)$", destination: { service: "eve-billing", type: "service" } },
      { src: "^/eve/billing/?$", destination: { service: "eve-billing", type: "service" } },
      { src: "^/eve/support/v1/(.*)$", destination: { service: "eve-support", type: "service" } },
      { src: "^/eve/support/?$", destination: { service: "eve-support", type: "service" } },
      { handle: "filesystem" },
      after,
    ]);
    expect(mergeEveVercelConfig(once, GENERATED_WORKSPACE)).toEqual(once);
  });

  it.each([{ routes: [null] }, { routes: [{ destination: { service: 1 } }] }])(
    "rejects malformed Build Output route data: %j",
    (existing) => {
      expect(() => mergeEveVercelConfig(existing, GENERATED)).toThrow(/config.json routes\[0\]/);
    },
  );

  it("preserves unknown keys and an explicit version", () => {
    const merged = mergeEveVercelConfig({ version: 2, cleanUrls: true }, GENERATED);
    expect(merged.version).toBe(2);
    expect(merged.cleanUrls).toBe(true);
  });
});
