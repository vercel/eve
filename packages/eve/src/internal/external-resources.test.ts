import { describe, expect, it } from "vitest";

import { buildExternalResourcesSnapshot } from "#internal/external-resources.js";

describe("external resources", () => {
  it("projects complete connection and channel requirements", () => {
    const snapshot = buildExternalResourcesSnapshot({
      generatorVersion: "1.2.3",
      manifest: {
        connections: [
          {
            connectionName: "linear",
            logicalPath: "connections/linear.ts",
            protocol: "mcp",
            url: "https://mcp.linear.app/mcp",
            vercelConnect: {
              connector: "linear/my-agent",
              requirement: {
                reference: "connector:linear/my-agent",
                service: "linear",
                subjectTypes: ["user"],
                method: "oauth",
              },
            },
          },
          {
            connectionName: "legacy",
            logicalPath: "connections/legacy.ts",
            protocol: "mcp",
            url: "https://example.com/mcp",
            vercelConnect: { connector: "legacy" },
          },
        ],
        subagents: [],
        channelRoutes: {
          effective: [
            {
              adapterKind: "slack",
              logicalPath: "channels/slack.ts",
              manifest: {
                $type: "https://docs.slack.dev/reference/app-manifest/",
                display_information: { name: "slack" },
              },
              name: "slack",
              urlPath: "/eve/v1/slack",
              vercelConnect: {
                connector: "slack/my-agent",
                requirement: {
                  reference: "connector:slack/my-agent",
                  service: "slack",
                  subjectTypes: ["app"],
                  method: "slack",
                },
              },
            },
          ],
        },
      } as never,
    });

    expect(snapshot).toEqual({
      generator: { name: "eve", version: "1.2.3" },
      kind: "eve-external-resources",
      resources: [
        {
          protocol: { type: "mcp", url: "https://mcp.linear.app/mcp" },
          credentials: {
            method: "oauth",
            reference: "connector:linear/my-agent",
            service: "linear",
            subjectTypes: ["user"],
          },
          kind: "connection",
          logicalPath: "connections/linear.ts",
          name: "linear",
        },
        {
          credentials: {
            method: "slack",
            reference: "connector:slack/my-agent",
            service: "slack",
            subjectTypes: ["app"],
          },
          kind: "channel",
          logicalPath: "channels/slack.ts",
          manifest: {
            $type: "https://docs.slack.dev/reference/app-manifest/",
            display_information: { name: "slack" },
          },
          name: "slack",
          route: { path: "/eve/v1/slack" },
        },
      ],
      schemaVersion: 1,
    });
  });

  it("prepends the public route prefix to channel routes", () => {
    const manifest = {
      channelRoutes: {
        effective: [
          {
            adapterKind: "custom",
            logicalPath: "channels/slack.ts",
            manifest: {
              $type: "https://docs.slack.dev/reference/app-manifest/",
              display_information: { name: "slack" },
            },
            name: "slack",
            urlPath: "/eve/v1/slack",
            vercelConnect: {
              connector: "slack/support",
              requirement: {
                reference: "connector:slack/support",
                service: "slack",
                subjectTypes: ["app"],
                method: "slack",
              },
            },
          },
        ],
      },
      connections: [],
      subagents: [],
    } as never;

    const snapshot = buildExternalResourcesSnapshot({
      generatorVersion: "1.2.3",
      manifest,
      publicRoutePrefix: "/eve/agents/support",
    });

    expect(snapshot.resources[0]).toMatchObject({
      route: { path: "/eve/agents/support/eve/v1/slack" },
    });
  });

  it("rejects Connect-backed OpenAPI connections without an explicit baseUrl", () => {
    const manifest = {
      channelRoutes: { effective: [] },
      connections: [
        {
          connectionName: "example",
          logicalPath: "connections/example.ts",
          protocol: "openapi",
          url: "",
          vercelConnect: {
            connector: "example",
            requirement: {
              reference: "connector:example",
              service: "example",
              subjectTypes: ["user"],
            },
          },
        },
      ],
      subagents: [],
    } as never;

    expect(() => buildExternalResourcesSnapshot({ generatorVersion: "1.2.3", manifest })).toThrow(
      'Connect-backed OpenAPI connection "example" must set baseUrl explicitly.',
    );
  });

  it("includes requirements declared by nested subagents", () => {
    const requirement = {
      reference: "connector:linear/worker",
      service: "linear",
      subjectTypes: ["user" as const],
      method: "oauth",
    };
    const manifest = {
      channelRoutes: { effective: [] },
      connections: [],
      subagents: [
        {
          agent: {
            channelRoutes: { effective: [] },
            connections: [
              {
                connectionName: "linear",
                logicalPath: "subagents/worker/connections/linear.ts",
                protocol: "mcp",
                url: "https://mcp.linear.app/mcp",
                vercelConnect: { connector: "linear/worker", requirement },
              },
            ],
          },
        },
      ],
    } as never;

    expect(
      buildExternalResourcesSnapshot({ generatorVersion: "1.2.3", manifest }).resources,
    ).toEqual([
      {
        protocol: { type: "mcp", url: "https://mcp.linear.app/mcp" },
        credentials: requirement,
        kind: "connection",
        logicalPath: "subagents/worker/connections/linear.ts",
        name: "linear",
      },
    ]);
  });
});
