import { beforeEach, describe, expect, test, vi } from "vitest";

const get = vi.fn();
vi.mock("@vercel/blob", () => ({ get }));

const { default: handler } = await import("./package.js");
const sha = "a".repeat(40);
const manifest = {
  sourceSha: sha,
  version: `0.33.1-main.${sha}`,
  tarball: "https://example.public.blob.vercel-storage.com/eve.tgz",
  sha256: "b".repeat(64),
};

function response() {
  return {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VERCEL_GIT_COMMIT_SHA = sha;
  get.mockImplementation(async () => ({
    stream: new Blob([JSON.stringify(manifest)]).stream(),
  }));
});

describe("package route", () => {
  test("resolves main through the deployment commit", async () => {
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(get).toHaveBeenCalledWith(`packages/${sha}/manifest.json`, {
      access: "public",
      useCache: false,
    });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.redirect).toHaveBeenCalledWith(302, manifest.tarball);
  });

  test("serves the current main manifest", async () => {
    const res = response();
    await handler({ query: { ref: "main", manifest: "1" } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(manifest);
  });

  test("serves SHA tarballs but not SHA latest manifests", async () => {
    const artifact = response();
    await handler({ query: { ref: sha } }, artifact);
    expect(artifact.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    expect(artifact.redirect).toHaveBeenCalledWith(302, manifest.tarball);

    const latest = response();
    await handler({ query: { ref: sha, manifest: "1" } }, latest);
    expect(latest.status).toHaveBeenCalledWith(404);
  });

  test("rejects unsupported refs and missing artifacts", async () => {
    const invalid = response();
    await handler({ query: { ref: "feature/test" } }, invalid);
    expect(invalid.status).toHaveBeenCalledWith(404);
    expect(get).not.toHaveBeenCalled();

    get.mockResolvedValueOnce(null);
    const missing = response();
    await handler({ query: { ref: sha } }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});
