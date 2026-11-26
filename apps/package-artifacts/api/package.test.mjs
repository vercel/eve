import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, test, vi } from "vitest";

const get = vi.fn();
vi.mock("@vercel/blob", () => ({ get }));

const { default: handler } = await import("./package.js");
const sha = "a".repeat(40);
const eve = {
  version: "0.33.0+git.aaaaaaaaaaaaaaaa",
  tarball: `https://pkg.eve.dev/${sha}/eve.tgz`,
  sha256: "b".repeat(64),
};
const video = {
  version: "0.0.0+git.aaaaaaaaaaaaaaaa",
  tarball: `https://pkg.eve.dev/${sha}/eve-video.tgz`,
  sha256: "c".repeat(64),
};
const manifest = { sourceSha: sha, ...eve, packages: { "@eve/video": video, eve } };
const legacyManifest = { sourceSha: sha, ...eve };

function response() {
  const stream = new PassThrough();
  stream.status = vi.fn().mockReturnValue(stream);
  stream.send = vi.fn().mockReturnValue(stream);
  stream.json = vi.fn().mockReturnValue(stream);
  stream.redirect = vi.fn().mockReturnValue(stream);
  stream.setHeader = vi.fn();
  return stream;
}

function serveBlobs(publishedManifest) {
  get.mockImplementation(async (pathname) => ({
    stream: new Blob([
      pathname.endsWith(".tgz") ? `bytes of ${pathname}` : JSON.stringify(publishedManifest),
    ]).stream(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  serveBlobs(manifest);
});

describe("package route", () => {
  test("resolves main through its published pointer", async () => {
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(get).toHaveBeenCalledWith("packages/refs/main.json", { access: "private" });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "public, max-age=60");
    expect(res.redirect).toHaveBeenCalledWith(302, eve.tarball);
  });

  test("resolves each package of a pull request through its published pointer", async () => {
    const res = response();
    await handler({ query: { ref: "123", package: "eve-video" } }, res);

    expect(get).toHaveBeenCalledWith("packages/refs/pr/123.json", { access: "private" });
    expect(res.redirect).toHaveBeenCalledWith(302, video.tarball);
  });

  test("serves mutable pointer manifests", async () => {
    const res = response();
    await handler({ query: { ref: "123", manifest: "1" } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(manifest);
  });

  test("serves SHA tarballs but not SHA manifests", async () => {
    const artifact = response();
    await handler({ query: { ref: sha, package: "eve-video" } }, artifact);
    expect(get).toHaveBeenLastCalledWith(`packages/${sha}/eve-video.tgz`, { access: "private" });
    expect(artifact.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=31536000, immutable",
    );
    expect(artifact.setHeader).toHaveBeenCalledWith("Content-Type", "application/gzip");
    expect(artifact.read()).toEqual(Buffer.from(`bytes of packages/${sha}/eve-video.tgz`));

    const latest = response();
    await handler({ query: { ref: sha, manifest: "1" } }, latest);
    expect(latest.status).toHaveBeenCalledWith(404);
  });

  test("serves eve from manifests published before multi-package artifacts", async () => {
    serveBlobs(legacyManifest);
    const pointer = response();
    await handler({ query: { ref: "main" } }, pointer);
    expect(pointer.redirect).toHaveBeenCalledWith(302, eve.tarball);

    const artifact = response();
    await handler({ query: { ref: sha } }, artifact);
    expect(artifact.read()).toEqual(Buffer.from(`bytes of packages/${sha}/eve.tgz`));

    const video = response();
    await handler({ query: { ref: "main", package: "eve-video" } }, video);
    expect(video.status).toHaveBeenCalledWith(404);
  });

  test("rejects pointers that redirect outside the package host", async () => {
    serveBlobs({
      ...manifest,
      packages: {
        ...manifest.packages,
        "@eve/video": { ...video, tarball: "https://x.dev/a.tgz" },
      },
    });
    const res = response();
    await handler({ query: { ref: "main" } }, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test("rejects unsupported refs, unknown packages, and missing artifacts", async () => {
    const invalid = response();
    await handler({ query: { ref: "feature/test" } }, invalid);
    expect(invalid.status).toHaveBeenCalledWith(404);
    expect(get).not.toHaveBeenCalled();

    const unknown = response();
    await handler({ query: { ref: sha, package: "eve-unknown" } }, unknown);
    expect(unknown.status).toHaveBeenCalledWith(404);
    expect(get).not.toHaveBeenCalledWith(`packages/${sha}/eve-unknown.tgz`, expect.anything());

    get.mockResolvedValueOnce(null);
    const missing = response();
    await handler({ query: { ref: sha } }, missing);
    expect(missing.status).toHaveBeenCalledWith(404);
  });
});
