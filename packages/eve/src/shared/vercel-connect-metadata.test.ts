import { describe, expect, it } from "vitest";

import { extractVercelConnectMetadata } from "#shared/vercel-connect-metadata.js";

const metadata = {
  connector: "slack/my-agent",
  requirement: {
    reference: "connector:slack/my-agent",
    service: "slack",
    subjectTypes: ["app"],
    method: "slack",
  },
};

describe("extractVercelConnectMetadata", () => {
  it("preserves a valid helper marker", () => {
    expect(extractVercelConnectMetadata(metadata)).toEqual(metadata);
  });

  it("preserves requirements without a credential method", () => {
    const { method: _method, ...requirement } = metadata.requirement;

    expect(extractVercelConnectMetadata({ ...metadata, requirement })).toEqual({
      connector: metadata.connector,
      requirement,
    });
  });

  it("preserves connector-only markers for runtime authorization", () => {
    expect(extractVercelConnectMetadata({ connector: metadata.connector })).toEqual({
      connector: metadata.connector,
    });
  });

  it("drops malformed requirements while preserving the runtime connector", () => {
    expect(
      extractVercelConnectMetadata({
        ...metadata,
        requirement: { ...metadata.requirement, service: "" },
      }),
    ).toEqual({ connector: metadata.connector });
  });
});
