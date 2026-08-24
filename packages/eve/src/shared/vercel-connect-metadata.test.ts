import { describe, expect, it } from "vitest";

import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";

const metadata = {
  connector: "slack/my-agent",
  connectorType: "slack",
  principalTypes: ["app"],
};

describe("extractVercelConnectMetadata", () => {
  it("preserves a valid helper marker", () => {
    expect(extractVercelConnectMetadata(metadata)).toEqual(metadata);
  });

  it("preserves connector-only markers for runtime authorization", () => {
    expect(extractVercelConnectMetadata({ connector: metadata.connector })).toEqual({
      connector: metadata.connector,
    });
  });

  it("drops malformed requirement fields while preserving the runtime connector", () => {
    expect(extractVercelConnectMetadata({ ...metadata, connectorType: "" })).toEqual({
      connector: metadata.connector,
    });
  });
});
