import { describe, expect, it } from "vitest";
import { createConnectManifest } from "#internal/connect-manifest.js";
import {
  createExternalResourcesSnapshot,
  type ExternalResource,
} from "#internal/external-resources-snapshot.js";

const connection: ExternalResource = {
  kind: "connection",
  name: "issues",
  logicalPath: "connections/issues.ts",
  credentials: { reference: "connector:slack/support", service: "slack", subjectTypes: ["user"] },
  protocol: { type: "mcp", url: "https://mcp.slack.com/mcp" },
};
const channel: ExternalResource = {
  kind: "channel",
  name: "support",
  logicalPath: "channels/support.ts",
  credentials: {
    reference: "connector:slack/support",
    service: "slack",
    method: "slack",
    subjectTypes: ["app"],
  },
  route: { path: "/eve/v1/support" },
  manifest: {
    $type: "https://docs.slack.dev/reference/app-manifest/",
    display_information: { name: "Support" },
  },
};
function compile(resources: ExternalResource[]) {
  return createConnectManifest(
    createExternalResourcesSnapshot({ generatorVersion: "1.2.3", resources }),
  );
}

describe("Connect manifest", () => {
  it("writes the v1 credential contract for connections without native configuration", () => {
    expect(compile([connection])).toEqual({
      generator: { name: "eve", version: "1.2.3" },
      kind: "vercel-connect-manifest",
      schemaVersion: 1,
      requirements: [
        {
          target: "connector:slack/support",
          connect: {
            service: "slack",
            subjectTypes: ["user"],
            manifest: { $type: "https://datatracker.ietf.org/doc/html/rfc7591" },
          },
          interfaces: [{ protocol: "mcp", url: "https://mcp.slack.com/mcp" }],
          triggers: [],
          uses: [{ kind: "connection", name: "issues", logicalPath: "connections/issues.ts" }],
        },
      ],
    });
  });
  it("combines compatible declarations without losing routes or duplicating uses", () => {
    const other = {
      ...channel,
      name: "other",
      logicalPath: "channels/other.ts",
      route: { path: "/eve/v1/other" },
    };
    const manifest = compile([channel, other, channel]);
    expect(manifest?.requirements).toHaveLength(1);
    expect(manifest?.requirements[0]).toMatchObject({
      target: channel.credentials.reference,
      connect: { type: "slack", subjectTypes: ["app"], manifest: channel.manifest },
      triggers: [{ path: "/eve/v1/support" }, { path: "/eve/v1/other" }],
    });
    expect(manifest?.requirements[0]?.uses).toHaveLength(2);
  });
  it("rejects a shared native channel and credential-only connection in either order", () => {
    for (const resources of [
      [connection, channel],
      [channel, connection],
    ]) {
      expect(() => compile(resources)).toThrow("Conflicting declarations");
    }
  });
  it.each<ExternalResource>([
    { ...channel, credentials: { ...channel.credentials, method: undefined } },
    { ...channel, credentials: { ...channel.credentials, subjectTypes: ["user" as const] } },
    { ...channel, manifest: { $type: "https://datatracker.ietf.org/doc/html/rfc7591" } },
    { ...channel, credentials: { ...channel.credentials, service: "github" } },
    { ...channel, credentials: { ...channel.credentials, method: "oauth" } },
    { ...channel, manifest: { ...channel.manifest, display_information: { name: "Different" } } },
  ])("rejects conflicting declarations for the same target", (conflicting) => {
    expect(() => compile([channel, conflicting])).toThrow(
      'Conflicting declarations for credential target "connector:slack/support"',
    );
  });
  it("accepts equivalent native configuration with different object key order", () => {
    expect(
      compile([
        channel,
        {
          ...channel,
          manifest: {
            display_information: { name: "Support" },
            $type: "https://docs.slack.dev/reference/app-manifest/",
          },
        },
      ])?.requirements,
    ).toHaveLength(1);
  });
  it("omits the artifact when no requirements were declared", () => {
    expect(compile([])).toBeUndefined();
  });
});
