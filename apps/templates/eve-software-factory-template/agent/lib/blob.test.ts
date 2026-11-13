import assert from "node:assert/strict";
import { mock, test } from "node:test";

const put = mock.fn(async (pathname: string) => ({ pathname }));
const get = mock.fn(async () => ({
  blob: { uploadedAt: new Date("2026-01-01T00:00:00Z") },
  stream: new Response("Private repository notes.").body,
}));
mock.module("@vercel/blob", {
  namedExports: {
    BlobNotFoundError: Error,
    del: mock.fn(),
    get,
    head: mock.fn(),
    put,
  },
});
const { readDocument, writeDocument } = await import("./blob.ts");

test("managed documents require private Blob access for both writes and reads", async () => {
  const key = "factory-brain/repository.md";
  const contents = "Private repository notes.";
  await writeDocument(key, contents, { allowOverwrite: true });
  assert.deepEqual(put.mock.calls[0]?.arguments, [
    key,
    contents,
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "text/markdown",
    },
  ]);
  assert.deepEqual(await readDocument(key), {
    content: contents,
    found: true,
    uploadedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(get.mock.calls[0]?.arguments, [key, { access: "private" }]);
});
