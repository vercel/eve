import { del, get, put } from "#compiled/@vercel/blob/index.js";
import { Headers } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { vercelBlobHandoff } from "#public/channels/discord/gateway/handoff.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({ del: vi.fn(), get: vi.fn(), put: vi.fn() }));

const PATHNAME = "eve/discord/gateway-session.json";
const SESSION = {
  resumeUrl: "wss://gateway.discord.gg",
  savedAt: 1_700_000_000_000,
  sequence: 42,
  sessionId: "S1",
};

function getBlobResult(content: string) {
  const url = `https://example.private.blob.vercel-storage.com/${PATHNAME}`;
  return {
    blob: {
      cacheControl: "max-age=0",
      contentDisposition: 'attachment; filename="gateway-session.json"',
      contentType: "application/json",
      downloadUrl: `${url}?download=1`,
      etag: "etag-1",
      pathname: PATHNAME,
      size: content.length,
      uploadedAt: new Date(0),
      url,
    },
    headers: new Headers(),
    statusCode: 200 as const,
    stream: new Response(content).body!,
  };
}

describe("vercelBlobHandoff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("takes the saved session from an uncached private read, then deletes it", async () => {
    vi.mocked(get).mockResolvedValue(getBlobResult(JSON.stringify(SESSION)));

    await expect(vercelBlobHandoff({ token: "rw" }).take()).resolves.toEqual(SESSION);
    expect(get).toHaveBeenCalledWith(
      PATHNAME,
      expect.objectContaining({ access: "private", token: "rw", useCache: false }),
    );
    expect(del).toHaveBeenCalledWith(PATHNAME, expect.objectContaining({ token: "rw" }));
  });

  it("finds nothing to take when no relay saved a session", async () => {
    vi.mocked(get).mockResolvedValue(null);

    await expect(vercelBlobHandoff().take()).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });

  it("overwrites the saved session in place", async () => {
    await vercelBlobHandoff({ pathname: "custom/session.json" }).put(SESSION);

    expect(put).toHaveBeenCalledWith(
      "custom/session.json",
      JSON.stringify(SESSION),
      expect.objectContaining({ access: "private", addRandomSuffix: false, allowOverwrite: true }),
    );
  });
});
