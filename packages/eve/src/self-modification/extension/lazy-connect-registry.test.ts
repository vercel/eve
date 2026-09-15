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
  it("uses a stable-in-source random connector UID", () => {
    expect(selfModificationConnectorUid("linear", () => "generated-id")).toBe(
      "linear-generated-id",
    );
  });

  it("generates 80 random bits as hex without requiring a project identifier", () => {
    const first = selfModificationConnectorUid("linear");
    const second = selfModificationConnectorUid("linear");

    expect(first).toMatch(/^linear-[0-9a-f]{20}$/u);
    expect(second).toMatch(/^linear-[0-9a-f]{20}$/u);
    expect(second).not.toBe(first);
  });

  it("rewrites only the matching generated auth declaration", () => {
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        connectorUid: "linear-generated-id",
        name: "linear",
      }),
    ).toContain('auth: connect("linear-generated-id")');
    expect(
      applySelfModificationLazyConnect(LINEAR_SOURCE, {
        connectorUid: "notion-generated-id",
        name: "notion",
      }),
    ).toBeUndefined();
  });

  it("ignores matching text outside the auth declaration", () => {
    const source = `// Legacy form: connect("linear")\n${LINEAR_SOURCE}`;
    const next = applySelfModificationLazyConnect(source, {
      connectorUid: "linear-generated-id",
      name: "linear",
    });

    expect(next).toContain('// Legacy form: connect("linear")');
    expect(next).toContain('auth: connect("linear-generated-id")');
  });

  it("fails closed for ambiguous auth declarations", () => {
    const source = `${LINEAR_SOURCE}\n  auth: connect("linear"),`;
    expect(
      applySelfModificationLazyConnect(source, {
        connectorUid: "linear-generated-id",
        name: "linear",
      }),
    ).toBeUndefined();
  });

  it("derives connector names only from authored connection targets", () => {
    expect(selfModificationLazyConnectName("agent/connections/linear.ts")).toBe("linear");
    expect(selfModificationLazyConnectName("agent/tools/linear.ts")).toBeUndefined();
    expect(selfModificationLazyConnectName("../agent/connections/linear.ts")).toBeUndefined();
  });

  it("rejects untrusted connector identity parts", () => {
    expect(() =>
      selfModificationConnectorUid("https://linear.example", () => "generated-id"),
    ).toThrow("connector name");
    expect(() => selfModificationConnectorUid("linear", () => 'bad"id')).toThrow(
      "connector identifier",
    );
  });
});
