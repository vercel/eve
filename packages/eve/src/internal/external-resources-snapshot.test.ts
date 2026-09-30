import { describe, expect, it } from "vitest";

import {
  createExternalResourcesSnapshot,
  type ExternalResource,
} from "#internal/external-resources-snapshot.js";

const resources: readonly ExternalResource[] = [
  {
    credentials: {
      method: "oauth",
      reference: "connector:oauth/linear",
      service: "linear",
      subjectTypes: ["user"],
    },
    kind: "connection",
    logicalPath: "connections/linear.ts",
    name: "linear",
    protocol: { type: "mcp", url: "https://mcp.linear.app/mcp" },
  },
  {
    credentials: {
      method: "slack",
      reference: "connector:slack/support",
      service: "slack",
      subjectTypes: ["app"],
    },
    kind: "channel",
    logicalPath: "channels/slack.ts",
    manifest: {
      $type: "https://docs.slack.dev/reference/app-manifest/",
      display_information: { name: "Support" },
    },
    name: "slack",
    route: { path: "/eve/v1/slack" },
  },
];

describe("external resources snapshot", () => {
  it("wraps generic resources in a versioned eve snapshot", () => {
    expect(createExternalResourcesSnapshot({ generatorVersion: "1.2.3", resources })).toEqual({
      generator: { name: "eve", version: "1.2.3" },
      kind: "eve-external-resources",
      resources,
      schemaVersion: 1,
    });
  });
});
