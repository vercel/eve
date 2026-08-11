import { describe, expect, it } from "vitest";

import { createEveServiceName } from "#internal/vercel/eve-service-contribution.js";
import { resolveCoDeployedEveServicePrefix } from "#internal/vercel/vercel-service-config-operations.js";
import { isValidVercelServiceName } from "#internal/vercel/vercel-service-name.js";

describe("resolveCoDeployedEveServicePrefix", () => {
  it("resolves the matching eve service only when it is co-deployed with a host", () => {
    expect(
      resolveCoDeployedEveServicePrefix({
        appRoots: ["/project/agents/support"],
        config: {
          services: {
            eve: { framework: "eve", root: "agents/support", routePrefix: "/support" },
            web: { framework: "nextjs", root: "." },
          },
        },
        configRoot: "/project",
      }),
    ).toBe("/support");
    expect(
      resolveCoDeployedEveServicePrefix({
        appRoots: ["/project/agents/support"],
        config: {
          services: {
            eve: { framework: "eve", root: "agents/support", routePrefix: "/support" },
          },
        },
        configRoot: "/project",
      }),
    ).toBeUndefined();
  });

  it("supports legacy service collections", () => {
    expect(
      resolveCoDeployedEveServicePrefix({
        appRoots: ["/project/agent"],
        config: {
          experimentalServices: {
            eve: { entrypoint: "agent", framework: "eve", mount: { path: "/agent" } },
            web: { framework: "nextjs" },
          },
        },
        configRoot: "/project",
      }),
    ).toBe("/agent");
  });
});

describe("createEveServiceName", () => {
  it("preserves public agent names that are valid service suffixes", () => {
    expect(createEveServiceName("customer-care")).toBe("eve-customer-care");
  });

  it("encodes digit-bearing public names into stable valid service names", () => {
    const serviceName = createEveServiceName("support2");
    expect(serviceName).toBe(createEveServiceName("support2"));
    expect(serviceName).not.toBe(createEveServiceName("support3"));
    expect(serviceName).toMatch(/^eve-support-[a-z]+$/);
    expect(isValidVercelServiceName(serviceName)).toBe(true);
  });

  it("truncates long names while retaining a distinguishing suffix", () => {
    const serviceName = createEveServiceName(`support-${"a".repeat(80)}`);
    expect(serviceName.length).toBeLessThanOrEqual(64);
    expect(isValidVercelServiceName(serviceName)).toBe(true);
  });
});
