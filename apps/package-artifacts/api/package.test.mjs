import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, test, vi } from "vitest";

const get = vi.fn();
vi.mock("@vercel/blob", () => ({ get }));

const { default: handler } = await import("./package.js");
const sha = "a".repeat(40);
const manifest = {
  sourceSha: sha,
  version: `0.33.0+main.${sha}`,
  tarball: `https://pkg.eve.dev/${sha}/eve.tgz`,
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
  get.mockImplementation(async (pathname) => ({
    stream: new Blob([
      pathname.endsWith("eve.tgz") ? "package bytes" : JSON.stringify(manifest),
    ]).stream(),
  }));
});

describe("package route", () => {
  test("resolves main through its published pointer", async () => {
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(get).toHaveBeenCalledWith("packages/refs/main.json", { access: "private" });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.redirect).toHaveBeenCalledWith(302, manifest.tarball);
  });

  test("resolves a pull request through its published pointer", async () => {
    const res = response();
    await handler({ query: { ref: "123" } }, res);

    expect(get).toHaveBeenCalledWith("packages/refs/pr/123.json", { access: "private" });
    expect(res.redirect).toHaveBeenCalledWith(302, manifest.tarball);
  });

  test("serves mutable pointer manifests", async () => {
    const res = response();
    await handler({ query: { ref: "123", manifest: "1" } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(manifest);
  });

  test("serves SHA tarballs but not SHA manifests", async () => {
    const artifact = response();
    await handler({ query: { ref: sha } }, artifact);
    expect(get).toHaveBeenLastCalledWith(`packages/${sha}/eve.tgz`, { access: "private" });
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

  test("rejects pointers that redirect outside the package host", async () => {
    get.mockResolvedValueOnce({
      stream: new Blob([
        JSON.stringify({ ...manifest, tarball: "https://example.com/eve.tgz" }),
      ]).stream(),
    });
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
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
