import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "#lib/vercel-blob/config.js") {
      const config = new URL(
        "../agent/lib/vercel-blob/config.ts",
        import.meta.url
      );
      return nextResolve(config.href, context);
    }
    return nextResolve(specifier, context);
  },
});
const get = mock.fn();
const list = mock.fn();
mock.module("@vercel/blob", {
  namedExports: { del: mock.fn(), get, head: mock.fn(), list, put: mock.fn() },
});
const { downloadAssetTool, listAssetsTool } =
  await import("../agent/lib/vercel-blob/tools.ts");
const download = downloadAssetTool();
const listAssets = listAssetsTool();
hooks.deregister();

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
  list.mock.mockImplementation(({ cursor, limit, prefix }) => {
    assert.equal(limit, 1);
    assert.equal(prefix, "");
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
    listAssets.inputSchema.parse({ limit: 1, prefix: "" })
  );
  assert.deepEqual(first.assets, []);
  assert.equal(first.hasMore, true);
  const second = await listAssets.execute(
    listAssets.inputSchema.parse({ cursor: first.cursor, limit: 1, prefix: "" })
  );
  assert.equal(second.count, 1);
  assert.equal(second.assets[0].pathname, "drafts/post.md");
  assert.equal(second.hasMore, false);
});
