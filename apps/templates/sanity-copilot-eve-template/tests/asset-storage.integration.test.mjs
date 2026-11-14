import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "#lib/reserved-paths.js") {
      const guard = new URL("../agent/lib/reserved-paths.ts", import.meta.url);
      return nextResolve(guard.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const put = mock.fn(async (pathname) => ({
  contentType: "text/plain",
  pathname,
  url: `https://assets.private.blob.vercel-storage.com/${pathname}`,
}));
const get = mock.fn(async () => ({
  blob: { contentType: "text/plain" },
  statusCode: 200,
  stream: new Response("draft").body,
}));
mock.module("@vercel/blob", { namedExports: { get, put } });
const { default: upload } = await import("../agent/tools/upload_asset.ts");
const { default: download } = await import("../agent/tools/download_asset.ts");
hooks.deregister();

test("upload denies normalized memory paths before storage, but dispatches ordinary assets", async () => {
  const blocked = await upload.execute({
    allowOverwrite: true,
    content: "replacement",
    pathname: "/eve/memory/alice.md",
  });
  assert.equal(blocked.success, false);
  assert.equal(put.mock.callCount(), 0);

  const allowed = await upload.execute({
    content: "draft",
    pathname: "drafts/post.md",
  });
  assert.equal(allowed.success, true);
  assert.equal(put.mock.callCount(), 1);
});

test("download denies encoded memory URLs before storage, but returns ordinary assets", async () => {
  const blocked = await download.execute({
    url: "https://assets.private.blob.vercel-storage.com/ev%65/memory/alice.md",
  });
  assert.equal(blocked.success, false);
  assert.equal(get.mock.callCount(), 0);

  const allowed = await download.execute({
    url: "https://assets.private.blob.vercel-storage.com/drafts/post.md",
  });
  assert.equal(allowed.success, true);
  assert.equal(allowed.content, "draft");
  assert.equal(get.mock.callCount(), 1);
});
