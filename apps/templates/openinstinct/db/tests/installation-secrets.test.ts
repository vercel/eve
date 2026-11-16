import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { get, put } from "@vercel/blob";
import { z } from "zod";
import type { InstallationSecrets } from "@db/services/installation-secrets";

const mocks = vi.hoisted(() => ({
  get: vi.fn<typeof get>(),
  put: vi.fn<typeof put>(),
}));

vi.mock("@vercel/blob", () => ({
  get: mocks.get,
  put: mocks.put,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
  vi.stubEnv("BLOB_STORE_ID", "store_openinstinct");
  vi.stubEnv("DATABASE_URL", "postgresql://user:password@example.com/database");
  vi.stubEnv("KERNEL_API_KEY", "test-kernel-key");
  vi.stubEnv("SECRET_ENCRYPTION_KEY", "");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_openinstinct");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("installation secrets", () => {
  it("atomically creates and caches independent secrets in private Blob", async () => {
    mocks.get.mockResolvedValue(null);
    mocks.put.mockResolvedValue({
      contentDisposition: "attachment",
      contentType: "application/json",
      downloadUrl:
        "https://store.private.blob.vercel-storage.com/openinstinct/system/installation-secrets.v1.json?download=1",
      etag: "etag-created",
      pathname: "openinstinct/system/installation-secrets.v1.json",
      url: "https://store.private.blob.vercel-storage.com/openinstinct/system/installation-secrets.v1.json",
    });

    const getInstallationSecrets = await loadInstallationSecrets();
    const [first, second] = await Promise.all([
      getInstallationSecrets(),
      getInstallationSecrets(),
    ]);

    expect(first).toEqual(second);
    expect(first.betterAuthSecret).not.toBe(first.secretEncryptionKey);
    expect(Buffer.from(first.betterAuthSecret, "base64")).toHaveLength(32);
    expect(Buffer.from(first.secretEncryptionKey, "base64")).toHaveLength(32);
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.put).toHaveBeenCalledOnce();
    const call = mocks.put.mock.calls[0];
    if (!call) throw new Error("Expected an installation secrets upload.");
    const [pathname, body, options] = call;
    expect(pathname).toMatch(
      /^openinstinct\/system\/[a-f0-9]{32}\/installation-secrets\.v1\.json$/u
    );
    const serialized = z.string().parse(body);
    expect(JSON.parse(serialized)).toEqual(first);
    expect(options).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(options).not.toHaveProperty("storeId");
    expect(options).not.toHaveProperty("token");
  });

  it("reads the winning value when another runtime creates it first", async () => {
    const winner = {
      betterAuthSecret: Buffer.alloc(32, 2).toString("base64"),
      secretEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
      version: 1 as const,
    };
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(blobResult(winner));
    mocks.put.mockRejectedValue(new Error("pathname already exists"));

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).resolves.toEqual(winner);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit overrides without accessing Blob", async () => {
    const configured = {
      betterAuthSecret: Buffer.alloc(32, 4).toString("base64"),
      secretEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
      version: 1 as const,
    };
    vi.stubEnv("BETTER_AUTH_SECRET", configured.betterAuthSecret);
    vi.stubEnv("SECRET_ENCRYPTION_KEY", configured.secretEncryptionKey);

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).resolves.toEqual(configured);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("rejects a partial explicit override", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", Buffer.alloc(32, 6).toString("base64"));

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY"
    );
  });

  it("retries after a transient Blob read failure", async () => {
    mocks.get
      .mockRejectedValueOnce(new Error("Blob temporarily unavailable"))
      .mockResolvedValueOnce(null);
    mocks.put.mockResolvedValue({
      contentDisposition: "attachment",
      contentType: "application/json",
      downloadUrl:
        "https://store.private.blob.vercel-storage.com/installation-secrets.json?download=1",
      etag: "etag-retry",
      pathname: "installation-secrets.json",
      url: "https://store.private.blob.vercel-storage.com/installation-secrets.json",
    });

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Blob temporarily unavailable"
    );
    await expect(getInstallationSecrets()).resolves.toMatchObject({
      version: 1,
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it("rejects malformed installation-secret storage", async () => {
    mocks.get.mockResolvedValue(blobResult({ version: 1 }));

    const getInstallationSecrets = await loadInstallationSecrets();

    await expect(getInstallationSecrets()).rejects.toThrow(
      "Invalid input: expected string"
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });
});

async function loadInstallationSecrets() {
  const secretsModule = await import("@db/services/installation-secrets");
  return secretsModule.getInstallationSecrets;
}

type InstallationSecretsFixture = Partial<InstallationSecrets> &
  Pick<InstallationSecrets, "version">;

function blobResult(value: InstallationSecretsFixture) {
  const body = JSON.stringify(value);
  const stream = new Response(body).body;
  if (!stream) throw new Error("Expected a response body.");
  return {
    blob: {
      cacheControl: "public, max-age=31536000",
      contentDisposition: "attachment",
      contentType: "application/json",
      downloadUrl:
        "https://store.private.blob.vercel-storage.com/openinstinct/system/installation-secrets.v1.json?download=1",
      etag: "etag-winner",
      pathname: "openinstinct/system/installation-secrets.v1.json",
      size: Buffer.byteLength(body),
      uploadedAt: new Date("2026-08-31T00:00:00.000Z"),
      url: "https://store.private.blob.vercel-storage.com/openinstinct/system/installation-secrets.v1.json",
    },
    headers: new Headers(),
    statusCode: 200 as const,
    stream,
  };
}
