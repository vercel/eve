import { describe, expect, it } from "vitest";

import {
  applySelfModificationLazyConnect,
  selfModificationConnectorUid,
  selfModificationLazyConnectName,
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

  it("rewrites only the matching generated auth declaration", () => {
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        name: "linear",
        projectId: "prj_abc123",
      }),
    ).toContain('auth: connect("linear-prj_abc123")');
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        name: "notion",
        projectId: "prj_abc123",
      }),
    ).toBeUndefined();
  });

  it("ignores matching text outside the auth declaration", () => {
    const source = `// Legacy form: connect("linear")\n${LINEAR_SOURCE}`;
    const next = applySelfModificationLazyConnect(source, {
      name: "linear",
      projectId: "prj_abc123",
    });

    expect(next).toContain('// Legacy form: connect("linear")');
    expect(next).toContain('auth: connect("linear-prj_abc123")');
  });

  it("fails closed for ambiguous auth declarations", () => {
    const source = `${LINEAR_SOURCE}\n  auth: connect("linear"),`;
    expect(
      applySelfModificationLazyConnect(source, {
        name: "linear",
        projectId: "prj_abc123",
      }),
    ).toBeUndefined();
  });

  it("derives connector names only from authored connection targets", () => {
    expect(selfModificationLazyConnectName("agent/connections/linear.ts")).toBe("linear");
    expect(selfModificationLazyConnectName("agent/tools/linear.ts")).toBeUndefined();
    expect(selfModificationLazyConnectName("../agent/connections/linear.ts")).toBeUndefined();
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
