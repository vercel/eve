import assert from "node:assert/strict";
import { test } from "node:test";
import { isReservedPath, isReservedUrl } from "../agent/lib/reserved-paths.ts";

const host = "https://assets.private.blob.vercel-storage.com/";

for (const pathname of [
  "/eve/memory/alice.md",
  "ev%65/memory/alice.md",
  "eve%2fmemory/alice.md",
  "%2Feve/memory/alice.md",
  "user-preferences/alice.md",
]) {
  test(`refuses reserved storage and URL path: ${pathname}`, () => {
    assert.equal(isReservedPath(pathname), true);
    assert.equal(isReservedUrl(`${host}${pathname}`), true);
  });
}

for (const pathname of [
  "drafts/bad%",
  "drafts/%C0%AF",
  "ev%2565/memory/alice.md",
  "drafts/%2e%2e%2feve/memory/alice.md",
  "drafts\\..\\eve\\memory\\alice.md",
  "drafts/%00post.md",
]) {
  test(`fails closed on ambiguous storage and URL path: ${pathname}`, () => {
    assert.equal(isReservedPath(pathname), true);
    assert.equal(isReservedUrl(`${host}${pathname}`), true);
  });
}

test("fails closed on an unparseable URL", () => {
  assert.equal(isReservedUrl("not a URL"), true);
});

test("allows ordinary assets and singly encoded filenames", () => {
  for (const pathname of [
    "drafts/post.md",
    "drafts/memory/post.md",
    "eve/memory-backup/post.md",
    "drafts/launch%20post.md",
    "drafts/caf%C3%A9.md",
  ]) {
    assert.equal(isReservedPath(pathname), false, pathname);
    assert.equal(isReservedUrl(`${host}${pathname}`), false, pathname);
  }
});
