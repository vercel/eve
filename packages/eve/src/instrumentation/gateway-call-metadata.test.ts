import { describe, expect, it } from "vitest";

import { gatewayCallMetadata } from "#instrumentation/gateway-call-metadata.js";

describe("gatewayCallMetadata", () => {
  it.each([
    undefined,
    {},
    { gateway: null },
    { gateway: "gateway" },
    { gateway: [] },
    { gateway: new Date() },
    { gateway: { generationId: 123 } },
    { gateway: { generationId: "" } },
    { gateway: { transcripts: { enabled: "true" } } },
    { gateway: { transcripts: { enabled: false } } },
    { gateway: { transcripts: true } },
    { gateway: { transcripts: null } },
    { gateway: { transcripts: [] } },
  ])("omits absent or invalid Gateway identifiers (%j)", (metadata) => {
    expect(gatewayCallMetadata(metadata)).toBeUndefined();
  });

  it.each([
    [{ generationId: "gen_123" }, { generationId: "gen_123" }],
    [{ transcripts: { enabled: true } }, { transcriptsEnabled: true }],
    [
      { generationId: "gen_123", transcripts: { enabled: true } },
      { generationId: "gen_123", transcriptsEnabled: true },
    ],
    [{ generationId: "gen_123", transcripts: { enabled: "true" } }, { generationId: "gen_123" }],
    [{ generationId: "", transcripts: { enabled: true } }, { transcriptsEnabled: true }],
  ])("returns only valid identifiers in an immutable snapshot (%j)", (gateway, expected) => {
    const metadata = gatewayCallMetadata({ gateway });
    expect(metadata).toEqual(expected);
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});
