import { describe, expect, it } from "vitest";

import {
  parseOfficialRegistrySearchMetadata,
  parseRegistryPresentationManifest,
} from "./registry-metadata.js";

describe("registry metadata", () => {
  it("parses official search metadata by item name", () => {
    const metadata = parseOfficialRegistrySearchMetadata({
      items: [
        {
          name: "channel/photon-imessage",
          meta: {
            eve: { docs: "/docs/channels/photon", implementation: "native" },
          },
        },
        { name: "experimental/self-modification/prod", meta: { eve: { hidden: true } } },
        { name: "extension/browser" },
      ],
    });

    expect([...metadata]).toEqual([
      ["channel/photon-imessage", { docs: "/docs/channels/photon", implementation: "native" }],
      ["experimental/self-modification/prod", { hidden: true }],
    ]);
  });

  it("rejects malformed official catalog items", () => {
    expect(() => parseOfficialRegistrySearchMetadata({ items: [{ name: 42 }] })).toThrow();
  });

  it("returns undefined for values that cannot be presented as manifests", () => {
    expect(parseRegistryPresentationManifest(["not", "a", "manifest"])).toBeUndefined();
  });
});
