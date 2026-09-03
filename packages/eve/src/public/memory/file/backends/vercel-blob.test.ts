import { BlobPreconditionFailedError, get, put } from "#compiled/@vercel/blob/index.js";
import { Headers } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryDocumentConflictError } from "#public/memory/file/backend.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  get: vi.fn(),
  put: vi.fn(),
}));

const signal = new AbortController().signal;

function getBlobResult(content: string, etag: string) {
  const pathname = "eve/memory/file/mem_a/MEMORY.md";
  const url = `https://example.public.blob.vercel-storage.com/${pathname}`;
  return {
    blob: {
      cacheControl: "max-age=0",
      contentDisposition: 'attachment; filename="MEMORY.md"',
      contentType: "text/markdown; charset=utf-8",
      downloadUrl: `${url}?download=1`,
      etag,
      pathname,
      size: content.length,
      uploadedAt: new Date(0),
      url,
    },
    headers: new Headers(),
    statusCode: 200 as const,
    stream: new Response(content).body!,
  };
}

function putBlobResult(etag: string) {
  return {
    contentDisposition: 'attachment; filename="MEMORY.md"',
    contentType: "text/markdown; charset=utf-8",
    downloadUrl: "https://example.public.blob.vercel-storage.com/MEMORY.md?download=1",
    etag,
    pathname: "eve/memory/file/mem_a/MEMORY.md",
    url: "https://example.public.blob.vercel-storage.com/MEMORY.md",
  };
}

describe("Vercel Blob file-memory backend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads private uncached Markdown by stable pathname", async () => {
    vi.mocked(get).mockResolvedValue(getBlobResult("# Memory", "etag-1"));
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
    vi.mocked(put).mockResolvedValue(putBlobResult("etag-next"));
    const backend = vercelBlob();

    await expect(
      backend.write({ content: "new", expectedVersion: null, key: "mem_a", signal }),
    ).resolves.toEqual({ content: "new", version: "etag-next" });
    expect(put).toHaveBeenNthCalledWith(1, "eve/memory/file/mem_a/MEMORY.md", "new", {
      abortSignal: signal,
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
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
      contentType: "text/markdown; charset=utf-8",
      ifMatch: "etag-old",
      oidcToken: undefined,
      storeId: undefined,
      token: undefined,
    });
  });

  it("uses the underlying Blob ETag when CDN compression weakens the response validator", async () => {
    const content = "x".repeat(1_025);
    vi.mocked(get).mockResolvedValue(getBlobResult(content, 'W/"etag-current"'));
    vi.mocked(put).mockResolvedValue(putBlobResult('"etag-next"'));
    const backend = vercelBlob();

    const document = await backend.read({ key: "mem_a", signal });
    expect(document).toEqual({ content, version: '"etag-current"' });
    if (document === null) throw new Error("Expected a memory document.");

    await expect(
      backend.write({
        content: `${content} next`,
        expectedVersion: document.version,
        key: "mem_a",
        signal,
      }),
    ).resolves.toEqual({ content: `${content} next`, version: '"etag-next"' });
    expect(put).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      `${content} next`,
      expect.objectContaining({ ifMatch: '"etag-current"' }),
    );
  });

  it("normalizes conditional and duplicate-create failures", async () => {
    const backend = vercelBlob();
    vi.mocked(put).mockRejectedValueOnce(new BlobPreconditionFailedError());

    await expect(
      backend.write({ content: "next", expectedVersion: "stale", key: "mem_a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);

    vi.mocked(put).mockRejectedValueOnce(new Error("already exists"));
    vi.mocked(get).mockResolvedValueOnce(getBlobResult("current", "etag-current"));
    await expect(
      backend.write({ content: "new", expectedVersion: null, key: "mem_a", signal }),
    ).rejects.toSatisfy(MemoryDocumentConflictError.is);
  });

  it("rejects an empty object prefix", () => {
    expect(() => vercelBlob({ prefix: "///" })).toThrow("prefix cannot be empty");
  });
});
