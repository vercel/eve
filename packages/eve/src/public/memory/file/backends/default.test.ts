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

  it("uses process-local storage outside Vercel and caches that selection", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    const backend = defaultFileMemoryBackend();
    await backend.write({ content: "local", expectedVersion: null, key: "mem_a", signal });
    vi.stubEnv("VERCEL", "1");

    await expect(backend.read({ key: "mem_a", signal })).resolves.toMatchObject({
      content: "local",
    });
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("defers Vercel Blob selection until the first operation", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const backend = defaultFileMemoryBackend();
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_STORE_ID", "store_test");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", undefined);
    vi.mocked(get).mockResolvedValue(null);

    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith(
      "eve/memory/file/mem_a/MEMORY.md",
      expect.objectContaining({ access: "private", useCache: false }),
    );
  });

  it("requires an explicit backend in non-Vercel production", async () => {
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    const backend = defaultFileMemoryBackend();

    await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
      "requires an explicit backend outside Vercel in production",
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("uses Vercel Blob with a read-write token", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_store_test_secret");
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("BLOB_STORE_ID", undefined);
    vi.mocked(get).mockResolvedValue(null);

    const backend = defaultFileMemoryBackend();
    await expect(backend.read({ key: "mem_a", signal })).resolves.toBeNull();
    expect(get).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "no Blob environment", oidcToken: undefined, storeId: undefined, token: undefined },
    { label: "OIDC without a store ID", oidcToken: "oidc", storeId: undefined, token: undefined },
    { label: "empty Blob values", oidcToken: "oidc", storeId: " ", token: " " },
  ])("rejects Vercel without an attached Blob store: $label", async (environment) => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", environment.token);
    vi.stubEnv("VERCEL_OIDC_TOKEN", environment.oidcToken);
    vi.stubEnv("BLOB_STORE_ID", environment.storeId);
    const backend = defaultFileMemoryBackend();

    await expect(async () => await backend.read({ key: "mem_a", signal })).rejects.toThrow(
      "requires an attached Vercel Blob store on Vercel",
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
