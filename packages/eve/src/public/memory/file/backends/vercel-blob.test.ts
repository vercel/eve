import { BlobPreconditionFailedError, get, put } from "#compiled/@vercel/blob/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryDocumentConflictError } from "#public/memory/file/backend.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  get: vi.fn(),
  put: vi.fn(),
}));

const signal = new AbortController().signal;

describe("Vercel Blob file-memory backend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads private uncached Markdown by stable pathname", async () => {
    vi.mocked(get).mockResolvedValue({
      blob: { etag: "etag-1" },
      statusCode: 200,
      stream: new Response("# Memory").body!,
    });
    const backend = vercelBlob({
      oidcToken: "oidc",
      prefix: "/custom/memory/",
      storeId: "store",
      token: "rw",
    });

    await expect(backend.read({ key: "mem_scope", signal })).resolves.toEqual({
      content: "# Memory",
      version: "etag-1",
    });
    expect(get).toHaveBeenCalledWith("custom/memory/mem_scope/MEMORY.md", {
      abortSignal: signal,
      access: "private",
      oidcToken: "oidc",
      storeId: "store",
      token: "rw",
      useCache: false,
    });
  });

  it("creates and conditionally replaces deterministic private objects", async () => {
    vi.mocked(put).mockResolvedValue({ etag: "etag-next" });
    const backend = vercelBlob();

    await expect(
      backend.write({ content: "new", expectedVersion: null, key: "mem_a", signal }),
    ).resolves.toEqual({ content: "new", version: "etag-next" });
    expect(put).toHaveBeenNthCalledWith(1, "eve/memory/file/mem_a/MEMORY.md", "new", {
      abortSignal: signal,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      contentType: "text/markdown; charset=utf-8",
      ifMatch: undefined,
      oidcToken: undefined,
      storeId: undefined,
      token: undefined,
    });

    await backend.write({ content: "next", expectedVersion: "etag-old", key: "mem_a", signal });
    expect(put).toHaveBeenNthCalledWith(2, "eve/memory/file/mem_a/MEMORY.md", "next", {
      abortSignal: signal,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "text/markdown; charset=utf-8",
      ifMatch: "etag-old",
      oidcToken: undefined,
      storeId: undefined,
      token: undefined,
    });
  });

  it("normalizes conditional and duplicate-create failures", async () => {
    const backend = vercelBlob();
    vi.mocked(put).mockRejectedValueOnce(new BlobPreconditionFailedError());

    await expect(
      backend.write({ content: "next", expectedVersion: "stale", key: "mem_a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);

    vi.mocked(put).mockRejectedValueOnce(new Error("already exists"));
    vi.mocked(get).mockResolvedValueOnce({
      blob: { etag: "etag-current" },
      statusCode: 200,
      stream: new Response("current").body!,
    });
    await expect(
      backend.write({ content: "new", expectedVersion: null, key: "mem_a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
  });

  it("rejects an empty object prefix", () => {
    expect(() => vercelBlob({ prefix: "///" })).toThrow("prefix cannot be empty");
  });
});
