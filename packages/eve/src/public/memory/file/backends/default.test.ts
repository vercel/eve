import { get, put } from "#compiled/@vercel/blob/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultFileMemoryBackend } from "#public/memory/file/backends/default.js";

vi.mock("#compiled/@vercel/blob/index.js", () => ({
  BlobPreconditionFailedError: class BlobPreconditionFailedError extends Error {},
  get: vi.fn(),
  put: vi.fn(),
}));

const signal = new AbortController().signal;

describe("default file-memory backend", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses shared process-local storage during eve dev", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("VERCEL", undefined);
    const first = defaultFileMemoryBackend();
    const second = defaultFileMemoryBackend();
    const key = `mem_${crypto.randomUUID()}`;

    await first.write({ content: "local", expectedVersion: null, key, signal });
    await expect(second.read({ key, signal })).resolves.toMatchObject({ content: "local" });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("caches the lazily selected backend for one provider", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("VERCEL", undefined);
    const backend = defaultFileMemoryBackend();
    const key = `mem_${crypto.randomUUID()}`;
    await backend.write({ content: "local", expectedVersion: null, key, signal });
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("VERCEL", "1");

    await expect(backend.read({ key, signal })).resolves.toMatchObject({ content: "local" });
    expect(get).not.toHaveBeenCalled();
  });

  it("defers Vercel Blob selection until the first operation", async () => {
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("VERCEL", undefined);
    const backend = defaultFileMemoryBackend();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_STORE_ID", "store_test");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc_test");
    vi.mocked(get).mockResolvedValue(null);

    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({
        access: "private",
        oidcToken: undefined,
        storeId: "store_test",
        useCache: false,
      }),
    );
  });

  it.each([undefined, "development", "production", "staging"])(
    "requires an explicit backend outside Vercel and eve dev with NODE_ENV=%s",
    async (nodeEnv) => {
      vi.stubEnv("EVE_DEV", undefined);
      vi.stubEnv("VERCEL", undefined);
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "outside-vercel");
      const backend = defaultFileMemoryBackend();

      await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
        "requires an explicit backend outside Vercel and eve dev",
      );
      expect(get).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
    },
  );

  it("uses Vercel Blob with a read-write token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store_test_secret");
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", undefined);
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ token: "vercel_blob_rw_store_test_secret" }),
    );
  });

  it("prefers namespaced read-write credentials over generic Blob credentials", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("EVE_MEMORY_BLOB_READ_WRITE_TOKEN", "eve-memory-token");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "application-token");
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ token: "eve-memory-token" }),
    );
  });

  it("uses namespaced store identity with Vercel OIDC", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("EVE_MEMORY_BLOB_READ_WRITE_TOKEN", undefined);
    vi.stubEnv("EVE_MEMORY_BLOB_STORE_ID", "store_eve_memory");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "oidc_test");
    vi.stubEnv("BLOB_STORE_ID", "store_application");
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ oidcToken: undefined, storeId: "store_eve_memory" }),
    );
  });

  it("uses namespaced store identity with request-scoped OIDC", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("EVE_MEMORY_BLOB_READ_WRITE_TOKEN", undefined);
    vi.stubEnv("EVE_MEMORY_BLOB_STORE_ID", "store_eve_memory");
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", "store_application");
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ storeId: "store_eve_memory" }),
    );
  });

  it.each(["EVE_MEMORY_BLOB", "BLOB"])(
    "prefers %s store identity over static tokens without capturing OIDC credentials",
    async (prefix) => {
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("EVE_DEV", undefined);
      vi.stubEnv(`${prefix}_STORE_ID`, "store_memory");
      vi.stubEnv(`${prefix}_READ_WRITE_TOKEN`, "static-token");
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "application-token");
      vi.stubEnv("VERCEL_OIDC_TOKEN", "first-oidc-token");
      vi.mocked(get).mockResolvedValue(null);
      vi.mocked(put).mockResolvedValue({
        contentDisposition: 'attachment; filename="MEMORY.md"',
        contentType: "text/markdown; charset=utf-8",
        downloadUrl: "https://example.private.blob.vercel-storage.com/MEMORY.md?download=1",
        etag: "etag-next",
        pathname: "eve/memory/file/mem_a/MEMORY.md",
        url: "https://example.private.blob.vercel-storage.com/MEMORY.md",
      });

      const backend = defaultFileMemoryBackend();
      await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
      vi.stubEnv("VERCEL_OIDC_TOKEN", "rotated-oidc-token");
      await expect(
        backend.write({ content: "memory", expectedVersion: null, key: "mem_a", signal }),
      ).resolves.toEqual({ content: "memory", version: "etag-next" });

      const credentials = expect.objectContaining({
        oidcToken: undefined,
        storeId: "store_memory",
        token: undefined,
      });
      expect(get).toHaveBeenCalledWith("eve/memory/file/mem_a/MEMORY.md", credentials);
      expect(put).toHaveBeenCalledWith("eve/memory/file/mem_a/MEMORY.md", "memory", credentials);
    },
  );

  it("uses Vercel Blob with an attached store and request-scoped OIDC", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", undefined);
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", "store_test");
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledOnce();
  });

  it("gives Vercel selection precedence over eve dev", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", undefined);
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", undefined);
    const backend = defaultFileMemoryBackend();

    await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
      "/add memory/file",
    );
  });

  it.each([
    { label: "no Blob environment", oidcToken: undefined, storeId: undefined, token: undefined },
    { label: "OIDC without a store ID", oidcToken: "oidc", storeId: undefined, token: undefined },
    { label: "empty Blob values", oidcToken: " ", storeId: " ", token: " " },
  ])("rejects Vercel without usable Blob credentials: $label", async (environment) => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("EVE_DEV", undefined);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", environment.token);
    vi.stubEnv("VERCEL_OIDC_TOKEN", environment.oidcToken);
    vi.stubEnv("BLOB_STORE_ID", environment.storeId);
    const backend = defaultFileMemoryBackend();

    await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
      /EVE_MEMORY_BLOB_STORE_ID.*eve integration setup file-memory.*redeploy/u,
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
