import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, test, vi } from "vitest";

const get = vi.fn();
vi.mock("@vercel/blob", () => ({ get }));

const { default: handler } = await import("./package.js");
const sha = "a".repeat(40);
const manifest = {
  sourceSha: sha,
  version: `0.33.0+main.${sha}`,
  tarball: `https://packages.example.com/${sha}/eve.tgz`,
  sha256: "b".repeat(64),
};

function response() {
  const stream = new PassThrough();
  stream.status = vi.fn().mockReturnValue(stream);
  stream.send = vi.fn().mockReturnValue(stream);
  stream.json = vi.fn().mockReturnValue(stream);
  stream.redirect = vi.fn().mockReturnValue(stream);
  stream.setHeader = vi.fn();
  return stream;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VERCEL_GIT_COMMIT_SHA = sha;
  get.mockImplementation(async (pathname) => ({
    stream: new Blob([
      pathname.endsWith("manifest.json") ? JSON.stringify(manifest) : "package bytes",
    ]).stream(),
  }));
});

describe("package route", () => {
  test("resolves main through the deployment commit", async () => {
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(get).toHaveBeenCalledWith(`packages/${sha}/manifest.json`, {
      access: "private",
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
    expect(get).toHaveBeenLastCalledWith(`packages/${sha}/eve.tgz`, {
      access: "private",
    });
    expect(artifact.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    expect(artifact.setHeader).toHaveBeenCalledWith("Content-Type", "application/gzip");
    expect(artifact.read()).toEqual(Buffer.from("package bytes"));

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
