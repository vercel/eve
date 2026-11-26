import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { resolveConfiguredStorage } from "../../extension/lib/storage/default.ts";
import { inMemory } from "../../extension/lib/storage/in-memory.ts";
import { normalizeStorageKey } from "../../extension/lib/storage/key.ts";
import { MP4_BYTES, WEBM_BYTES } from "../helpers.ts";

const ENV_KEYS = [
  "EVE_VIDEO_BLOB_STORE_ID",
  "EVE_VIDEO_BLOB_READ_WRITE_TOKEN",
  "BLOB_STORE_ID",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "EVE_DEV",
] as const;

const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearStorageEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = savedEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

describe("normalizeStorageKey", () => {
  test("accepts relative nested keys and rejects traversal, slashes, and control characters", () => {
    assert.equal(normalizeStorageKey("videos/2026-11-26/clip.mp4"), "videos/2026-11-26/clip.mp4");

    const invalidKeys = [
      "",
      "   ",
      "/leading.mp4",
      "trailing/",
      "../escape.mp4",
      "videos/../escape.mp4",
      "videos/..hidden.mp4",
      "videos/./clip.mp4",
      "videos//clip.mp4",
      "videos\\clip.mp4",
      "videos/clip\x00.mp4",
      "videos/clip\n.mp4",
    ];
    for (const key of invalidKeys) {
      assert.throws(
        () => normalizeStorageKey(key),
        TypeError,
        `expected rejection: ${JSON.stringify(key)}`,
      );
    }
  });
});

describe("inMemory storage adapter", () => {
  test("supports put, get, delete, keys, clear, and defensive byte isolation", async () => {
    const storage = inMemory();
    const signal = new AbortController().signal;
    const original = Uint8Array.from(MP4_BYTES);

    const stored = await storage.put({
      key: "videos/2026-11-26/clip.mp4",
      data: original,
      mediaType: "video/mp4",
      filename: "clip.mp4",
      signal,
    });

    assert.equal(stored.key, "videos/2026-11-26/clip.mp4");
    assert.equal(stored.mediaType, "video/mp4");
    assert.equal(stored.bytes, MP4_BYTES.byteLength);
    assert.equal(stored.url, undefined);
    assert.equal(stored.visibility, undefined);

    original[0] = 0x99;

    const loaded = await storage.get({ key: "videos/2026-11-26/clip.mp4", signal });
    assert.notEqual(loaded, null);
    assert.deepEqual(loaded?.data, MP4_BYTES);

    if (loaded !== null) {
      loaded.data[0] = 0xaa;
    }
    const reloaded = await storage.get({ key: "videos/2026-11-26/clip.mp4", signal });
    assert.deepEqual(reloaded?.data, MP4_BYTES);

    await storage.put({
      key: "videos/2026-11-26/second.webm",
      data: WEBM_BYTES,
      mediaType: "video/webm",
      filename: "second.webm",
      signal,
    });
    assert.deepEqual(storage.keys(), [
      "videos/2026-11-26/clip.mp4",
      "videos/2026-11-26/second.webm",
    ]);

    await storage.delete({ key: "videos/2026-11-26/clip.mp4", signal });
    assert.equal(await storage.get({ key: "videos/2026-11-26/clip.mp4", signal }), null);
    assert.deepEqual(storage.keys(), ["videos/2026-11-26/second.webm"]);

    storage.clear();
    assert.deepEqual(storage.keys(), []);
  });

  test("applies baseUrl normalization and visibility defaults", async () => {
    const signal = new AbortController().signal;
    const publicStorage = inMemory({ baseUrl: "https://cdn.example.com/media///" });
    const storedPublic = await publicStorage.put({
      key: "videos/a.mp4",
      data: MP4_BYTES,
      mediaType: "video/mp4",
      filename: "a.mp4",
      signal,
    });
    assert.equal(storedPublic.url, "https://cdn.example.com/media/videos/a.mp4");
    assert.equal(storedPublic.visibility, "public");

    const privateStorage = inMemory({
      baseUrl: "https://cdn.example.com/private",
      visibility: "private",
    });
    const storedPrivate = await privateStorage.put({
      key: "videos/b.mp4",
      data: MP4_BYTES,
      mediaType: "video/mp4",
      filename: "b.mp4",
      signal,
    });
    assert.equal(storedPrivate.url, "https://cdn.example.com/private/videos/b.mp4");
    assert.equal(storedPrivate.visibility, "private");

    assert.throws(() => inMemory({ baseUrl: "   " }), TypeError);
  });

  test("honors AbortSignal across put, get, and delete", async () => {
    const storage = inMemory();
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));

    await assert.rejects(
      () =>
        storage.put({
          key: "videos/a.mp4",
          data: MP4_BYTES,
          mediaType: "video/mp4",
          filename: "a.mp4",
          signal: aborted.signal,
        }),
      /cancelled/,
    );
    await assert.rejects(
      () => storage.get({ key: "videos/a.mp4", signal: aborted.signal }),
      /cancelled/,
    );
    await assert.rejects(
      () => storage.delete({ key: "videos/a.mp4", signal: aborted.signal }),
      /cancelled/,
    );
  });
});

describe("resolveConfiguredStorage", () => {
  test("returns explicit adapter as-is and undefined when disabled with false or unconfigured", () => {
    clearStorageEnv();
    assert.equal(resolveConfiguredStorage(undefined), undefined);

    process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store123_secret";
    process.env.EVE_DEV = "1";

    const explicit = inMemory();
    assert.equal(resolveConfiguredStorage(explicit), explicit);
    assert.equal(resolveConfiguredStorage(false), undefined);
  });

  test("auto-selects storage for EVE_VIDEO_BLOB_*, VERCEL + BLOB_*, and EVE_DEV=1", () => {
    clearStorageEnv();
    process.env.EVE_VIDEO_BLOB_STORE_ID = "store_abc";
    assert.equal(typeof resolveConfiguredStorage(undefined)?.put, "function");

    clearStorageEnv();
    process.env.EVE_VIDEO_BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store123_secret";
    assert.equal(typeof resolveConfiguredStorage(undefined)?.put, "function");

    clearStorageEnv();
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store123_secret";
    assert.equal(resolveConfiguredStorage(undefined), undefined);

    process.env.VERCEL = "1";
    assert.equal(typeof resolveConfiguredStorage(undefined)?.put, "function");

    clearStorageEnv();
    process.env.VERCEL = "1";
    process.env.BLOB_STORE_ID = "store_vercel";
    assert.equal(typeof resolveConfiguredStorage(undefined)?.put, "function");

    clearStorageEnv();
    process.env.EVE_DEV = "1";
    assert.equal(typeof resolveConfiguredStorage(undefined)?.put, "function");
  });
});
