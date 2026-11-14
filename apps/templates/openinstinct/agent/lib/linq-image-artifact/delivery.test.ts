/* oxlint-disable vitest/require-mock-type-parameters -- The Blob mock implements only the read operation exercised here. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@shared/identity/access-scope";

const firstId = "0d01e667-d128-4bb7-a248-1ae21db72f4f";
const secondId = "206c3a7e-c0b8-4317-9e34-552cff646673";
const mocks = vi.hoisted(() => ({ getBlob: vi.fn(), readArtifact: vi.fn() }));

vi.mock("@db/services/browser-images", () => ({
  readReadyBrowserImageArtifact: mocks.readArtifact,
}));
vi.mock("@vercel/blob", () => ({
  get: mocks.getBlob,
}));

import { prepareLinqImageArtifactDelivery } from "./delivery";

const scope = { userId: "user-1", workspaceId: "workspace-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readArtifact.mockImplementation(
    async (_scope: AccessScope, id: string) =>
      id === firstId
        ? {
            byteSize: 3,
            contentHash:
              "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
            filename: "product.png",
            id,
            mediaType: "image/png",
            storagePathname: "artifacts/first",
          }
        : undefined
  );
  mocks.getBlob.mockResolvedValue({
    blob: { contentType: "image/png", size: 3 },
    statusCode: 200,
    stream: new Response(new Uint8Array([1, 2, 3])).body,
  });
});

describe("Linq image artifact delivery", () => {
  it("loads scoped artifacts, deduplicates references, and strips internal URLs", async () => {
    const markdown = [
      "Here is the product.",
      `![Product](/artifacts/${firstId})`,
      `![Product again](/artifacts/${firstId})`,
    ].join("\n\n");

    const result = await prepareLinqImageArtifactDelivery(markdown, {
      rootSessionId: "root-session",
      scope,
    });

    expect(mocks.readArtifact).toHaveBeenCalledExactlyOnceWith(scope, firstId, {
      rootSessionId: "root-session",
      signal: undefined,
    });
    expect(result.text).toBe("Here is the product.");
    expect(result.files).toEqual([
      {
        data: Buffer.from([1, 2, 3]),
        filename: "product.png",
        mimeType: "image/png",
      },
    ]);
    expect(result.failedArtifactIds).toEqual([]);
  });

  it("keeps successful files while reporting unavailable artifacts", async () => {
    const result = await prepareLinqImageArtifactDelivery(
      [
        `![First](/artifacts/${firstId})`,
        `![Second](/artifacts/${secondId})`,
      ].join("\n"),
      { rootSessionId: "root-session", scope }
    );

    expect(result.files).toHaveLength(1);
    expect(result.failedArtifactIds).toEqual([secondId]);
    expect(result.text).toBe("");
  });

  it("leaves ordinary markdown untouched without storage reads", async () => {
    const markdown = "See ![external](https://example.com/product.png).";

    const result = await prepareLinqImageArtifactDelivery(markdown, {
      rootSessionId: "root-session",
      scope,
    });

    expect(result).toEqual({
      failedArtifactIds: [],
      files: [],
      text: markdown,
    });
    expect(mocks.readArtifact).not.toHaveBeenCalled();
  });
});
