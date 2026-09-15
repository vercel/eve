import { describe, expect, it } from "vitest";

import {
  applySelfModificationLazyConnect,
  isSelfModificationLazyConnectTarget,
  selfModificationConnectorUid,
} from "./lazy-connect-registry.js";

const LINEAR_SOURCE = `import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  auth: connect("linear"),
});
`;

describe("self-modification lazy Connect registry installs", () => {
  it("uses the stable Vercel project ID as the connector UID", () => {
    expect(selfModificationConnectorUid("linear", "prj_abc123")).toBe("linear-prj_abc123");
    expect(selfModificationConnectorUid("linear", "prj_other")).not.toBe(
      selfModificationConnectorUid("linear", "prj_abc123"),
    );
  });

  it("rewrites only the declared connector placeholder", () => {
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        canonicalName: "linear",
        projectId: "prj_abc123",
        service: "mcp.linear.app",
      }),
    ).toContain('auth: connect({ connector: "linear-prj_abc123", autoProvision: true })');
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        canonicalName: "notion",
        projectId: "prj_abc123",
        service: "mcp.notion.com",
      }),
    ).toBeUndefined();
  });

  it("accepts only authored connection targets", () => {
    expect(isSelfModificationLazyConnectTarget("agent/connections/linear.ts")).toBe(true);
    expect(isSelfModificationLazyConnectTarget("agent/tools/linear.ts")).toBe(false);
    expect(isSelfModificationLazyConnectTarget("../agent/connections/linear.ts")).toBe(false);
  });

  it("rejects untrusted connector identity parts", () => {
    expect(() => selfModificationConnectorUid("https://linear.example", "prj_abc123")).toThrow(
      "connector name",
    );
    expect(() => selfModificationConnectorUid("linear", "project-name")).toThrow(
      "project identifier",
    );
  });
});
