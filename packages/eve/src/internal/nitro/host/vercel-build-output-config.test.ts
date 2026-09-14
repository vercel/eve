import { describe, expect, it } from "vitest";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import {
  createEveVercelOptions,
  EVE_WORKFLOW_FLOW_ROUTE_PATH,
  parseVercelBunVersion,
} from "#internal/nitro/host/vercel-build-output-config.js";
import { deriveEveWorkflowQueueTopic } from "#internal/workflow/queue-namespace.js";

describe("createEveVercelOptions", () => {
  it("derives the function runtime from the vercel.json bunVersion", () => {
    expect(
      createEveVercelOptions({ agentName: "test-agent", enabled: true, bunVersion: "1.4.x" })
        ?.functions,
    ).toEqual({ runtime: "bun1.4.x" });
    expect(
      createEveVercelOptions({ agentName: "test-agent", enabled: true, bunVersion: "1.x" })
        ?.functions,
    ).toEqual({ runtime: "bun1.x" });
  });

  it("leaves the runtime to Nitro when no Bun version is selected", () => {
    for (const bunVersion of [undefined, "", "latest", "1.4.1"]) {
      expect(
        createEveVercelOptions({ agentName: "test-agent", enabled: true, bunVersion }),
      ).not.toHaveProperty("functions");
    }
  });

  it("returns undefined when the Vercel build output is disabled", () => {
    expect(createEveVercelOptions({ agentName: "test-agent", enabled: false })).toBeUndefined();
  });

  it("emits both framework slug and version so the proxy keeps the framework object", () => {
    expect(createEveVercelOptions({ agentName: "test-agent", enabled: true })?.config).toEqual({
      version: 3,
      framework: {
        slug: EVE_PACKAGE_NAME,
        version: resolveInstalledPackageInfo().version,
      },
    });
  });

  it("declares the queue-triggered workflow flow function through functionRules", () => {
    const options = createEveVercelOptions({ agentName: "test-agent", enabled: true });

    expect(options?.functionRules).toEqual({
      [EVE_WORKFLOW_FLOW_ROUTE_PATH]: {
        maxDuration: "max",
        experimentalTriggers: [
          {
            type: "queue/v2beta",
            topic: deriveEveWorkflowQueueTopic("test-agent"),
            consumer: "default",
            retryAfterSeconds: 5,
            initialDelaySeconds: 0,
          },
        ],
        environment: {
          WORKFLOW_PRECONDITION_GUARD: "1",
        },
      },
    });
  });

  it("omits the public route prefix from the flow environment when none is set", () => {
    for (const publicRoutePrefix of [undefined, ""]) {
      const options = createEveVercelOptions({
        agentName: "test-agent",
        enabled: true,
        publicRoutePrefix,
      });
      expect(options?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH].environment).not.toHaveProperty(
        "EVE_PUBLIC_ROUTE_PREFIX",
      );
    }
  });

  it("bakes the normalized public route prefix into the flow function environment", () => {
    const options = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      publicRoutePrefix: "eve/agents/support/",
    });

    expect(options?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH].environment).toEqual({
      WORKFLOW_PRECONDITION_GUARD: "1",
      EVE_PUBLIC_ROUTE_PREFIX: "/eve/agents/support",
    });
  });

  it("marks workspace-member flow functions without marking standalone agents", () => {
    const standalone = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      publicRoutePrefix: "/support",
    });
    const workspaceMember = createEveVercelOptions({
      agentName: "test-agent",
      enabled: true,
      publicRoutePrefix: "/support",
      workspaceMember: true,
    });

    expect(standalone?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH].environment).not.toHaveProperty(
      "EVE_INTERNAL_AGENT_WORKSPACE_MEMBER",
    );
    expect(workspaceMember?.functionRules[EVE_WORKFLOW_FLOW_ROUTE_PATH].environment).toMatchObject({
      EVE_INTERNAL_AGENT_WORKSPACE_MEMBER: "1",
    });
  });
});

describe("parseVercelBunVersion", () => {
  it("accepts the values Vercel documents", () => {
    expect(parseVercelBunVersion({ bunVersion: "1.4.x" })).toBe("1.4.x");
    expect(parseVercelBunVersion({ bunVersion: "1.x" })).toBe("1.x");
  });

  it("ignores missing and malformed values", () => {
    for (const config of [
      undefined,
      null,
      "1.4.x",
      {},
      { framework: "eve" },
      { bunVersion: 1.4 },
      { bunVersion: "1.4.1" },
      { bunVersion: "latest" },
    ]) {
      expect(parseVercelBunVersion(config)).toBeUndefined();
    }
  });
});
