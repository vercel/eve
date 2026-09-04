import { describe, expect, it } from "vitest";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import {
  createEveVercelOptions,
  EVE_WORKFLOW_FLOW_ROUTE_PATH,
} from "#internal/nitro/host/vercel-build-output-config.js";
import { deriveEveWorkflowQueueTopic } from "#internal/workflow/queue-namespace.js";

describe("createEveVercelOptions", () => {
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
            maxConcurrency: 1,
          },
        ],
        environment: {
          WORKFLOW_PRECONDITION_GUARD: "1",
          WORKFLOW_SEQUENTIAL_REPLAYS: "1",
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
      WORKFLOW_SEQUENTIAL_REPLAYS: "1",
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
