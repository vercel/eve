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
const list = mock.fn();
mock.module("@vercel/blob", { namedExports: { get, list, put } });
const { default: upload } = await import("../agent/tools/upload_asset.ts");
const { default: download } = await import("../agent/tools/download_asset.ts");
const { default: listAssets } = await import("../agent/tools/list_assets.ts");
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

const assetUrl =
  "https://assets.private.blob.vercel-storage.com/drafts/post.md";
const textLimit = 1024 * 1024;
const binaryLimit = 768 * 1024;

const serve = ({ chunks, contentType = "text/plain", size }) => {
  let reads = 0;
  const cancel = mock.fn();
  const stream = new ReadableStream(
    {
      cancel,
      pull(controller) {
        const chunk = chunks[reads];
        reads += 1;
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 }
  );
  get.mock.mockImplementation(async () => ({
    blob: { contentType, size },
    statusCode: 200,
    stream,
  }));
  return { cancel, reads: () => reads, stream };
};

for (const [contentType, limit] of [
  ["text/plain", textLimit],
  ["image/png", binaryLimit],
]) {
  for (const size of [undefined, 1, limit + 1]) {
    test(`download rejects and cancels oversized ${contentType} with size ${size}`, async () => {
      const source = serve({
        chunks: [new Uint8Array(limit), new Uint8Array(1), new Uint8Array(10)],
        contentType,
        size,
      });
      const result = await download.execute({ url: assetUrl });
      assert.equal(result.success, false);
      assert.ok(result.error.includes("too large"));
      assert.ok(result.error.includes("smaller"));
      assert.equal(result.content, undefined);
      assert.equal(source.cancel.mock.callCount(), 1);
      assert.equal(source.reads(), size > limit ? 0 : 2);
      assert.equal(source.stream.locked, false);
    });
  }
}

test("download refuses a single oversized chunk without consuming the rest", async () => {
  const source = serve({
    chunks: [new Uint8Array(textLimit + 1), new Uint8Array(10)],
  });
  const result = await download.execute({ url: assetUrl });
  assert.equal(result.success, false);
  assert.ok(result.error.includes("too large"));
  assert.equal(source.reads(), 1);
  assert.equal(source.cancel.mock.callCount(), 1);
});

for (const contentType of ["text/plain", "application/json"]) {
  test(`download preserves split UTF-8 ${contentType} and accepts the byte limit`, async () => {
    const bytes = Buffer.from(`\uFEFFé${"a".repeat(textLimit - 5)}`);
    const source = serve({
      chunks: [bytes.subarray(0, 4), bytes.subarray(4)],
      contentType,
      size: bytes.length,
    });
    const result = await download.execute({ url: assetUrl });
    assert.equal(result.success, true);
    assert.equal(result.content, `é${"a".repeat(textLimit - 5)}`);
    assert.equal(result.contentType, contentType);
    assert.equal(result.isBase64, false);
    assert.equal(source.cancel.mock.callCount(), 0);
    assert.equal(source.stream.locked, false);
  });
}

test("download preserves binary bytes while bounding base64 expansion", async () => {
  const bytes = Buffer.alloc(binaryLimit, 255);
  const source = serve({
    chunks: [bytes.subarray(0, 1), bytes.subarray(1)],
    contentType: "application/pdf",
    size: binaryLimit,
  });
  const result = await download.execute({ url: assetUrl });
  assert.equal(result.success, true);
  assert.equal(result.isBase64, true);
  assert.equal(result.contentType, "application/pdf");
  assert.equal(result.content.length, textLimit);
  assert.deepEqual(Buffer.from(result.content, "base64"), bytes);
  assert.equal(source.cancel.mock.callCount(), 0);
  assert.equal(source.stream.locked, false);
});

test("list follows the returned cursor even when reserved objects hide the first page", async () => {
  const blob = (pathname) => ({
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00Z"),
    url: `https://assets.private.blob.vercel-storage.com/${pathname}`,
  });
  list.mock.mockImplementation(({ cursor, limit }) => {
    assert.equal(limit, 1);
    return Promise.resolve(
      cursor === "next-page"
        ? { blobs: [blob("drafts/post.md")], hasMore: false }
        : {
            blobs: [blob("eve/memory/alice.md")],
            cursor: "next-page",
            hasMore: true,
          }
    );
  });
  const first = await listAssets.execute(
    listAssets.inputSchema.parse({ limit: 1 })
  );
  assert.deepEqual(first.assets, []);
  assert.equal(first.hasMore, true);
  const second = await listAssets.execute(
    listAssets.inputSchema.parse({ cursor: first.cursor, limit: 1 })
  );
  assert.equal(second.count, 1);
  assert.equal(second.assets[0].pathname, "drafts/post.md");
  assert.equal(second.hasMore, false);
});
