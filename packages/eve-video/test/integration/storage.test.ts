import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { resolveConfiguredStorage } from "../../extension/lib/storage/default.ts";
import { localDisk } from "../../extension/lib/storage/local-disk.ts";
import { FLAC_BYTES, M4A_BYTES, MP3_BYTES, MP4_BYTES, OGG_BYTES, WAV_BYTES } from "../helpers.ts";

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

describe("localDisk filesystem storage adapter", () => {
  test("persists atomically, detects video and audio media types on read, deletes cleanly, and returns null for missing keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-video-disk-"));
    try {
      const storage = localDisk({
        directory: root,
        publicBaseUrl: "https://files.example.com/videos///",
      });
      const signal = new AbortController().signal;

      const stored = await storage.put({
        key: "nested/2026-11-26/clip.mp4",
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: "clip.mp4",
        signal,
      });

      assert.equal(stored.key, "nested/2026-11-26/clip.mp4");
      assert.equal(stored.path, join(root, "nested", "2026-11-26", "clip.mp4"));
      assert.equal(stored.url, "https://files.example.com/videos/nested/2026-11-26/clip.mp4");
      assert.equal(stored.visibility, "public");
      assert.equal(stored.bytes, MP4_BYTES.byteLength);

      const dirEntries = await readdir(join(root, "nested", "2026-11-26"));
      assert.deepEqual(dirEntries, ["clip.mp4"]);

      const loaded = await storage.get?.({ key: "nested/2026-11-26/clip.mp4", signal });
      assert.notEqual(loaded, null);
      assert.deepEqual(loaded?.data, MP4_BYTES);
      assert.equal(loaded?.mediaType, "video/mp4");

      const audioFixtures: readonly (readonly [string, Uint8Array, string])[] = [
        ["audio/track.mp3", MP3_BYTES, "audio/mpeg"],
        ["audio/track.wav", WAV_BYTES, "audio/wav"],
        ["audio/track.m4a", M4A_BYTES, "audio/mp4"],
        ["audio/track.ogg", OGG_BYTES, "audio/ogg"],
        ["audio/track.flac", FLAC_BYTES, "audio/flac"],
      ];
      for (const [key, bytes, expectedMediaType] of audioFixtures) {
        await storage.put({
          key,
          data: bytes,
          mediaType: expectedMediaType,
          filename: key.slice(key.lastIndexOf("/") + 1),
          signal,
        });
        const readBack = await storage.get?.({ key, signal });
        assert.notEqual(readBack, null, key);
        assert.equal(readBack?.mediaType, expectedMediaType, key);
        assert.deepEqual(readBack?.data, bytes, key);
      }

      assert.equal(await storage.get?.({ key: "nested/2026-11-26/missing.mp4", signal }), null);

      await storage.delete?.({ key: "nested/2026-11-26/clip.mp4", signal });
      assert.equal(await storage.get?.({ key: "nested/2026-11-26/clip.mp4", signal }), null);
      await storage.delete?.({ key: "nested/2026-11-26/clip.mp4", signal });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("validates publicBaseUrl, directory, path traversal, and abort signals", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-video-disk-validation-"));
    try {
      assert.throws(() => localDisk({ directory: "   " }), TypeError);
      assert.throws(() => localDisk({ directory: root, publicBaseUrl: "not-a-url" }), TypeError);
      assert.throws(
        () => localDisk({ directory: root, publicBaseUrl: "file:///tmp/videos" }),
        TypeError,
      );
      assert.throws(
        () => localDisk({ directory: root, publicBaseUrl: "https://files.example.com/?token=1" }),
        TypeError,
      );
      assert.throws(
        () => localDisk({ directory: root, publicBaseUrl: "https://files.example.com/#frag" }),
        TypeError,
      );

      const storage = localDisk({ directory: root });
      const signal = new AbortController().signal;
      for (const badKey of ["../outside.mp4", "a/../../outside.mp4", "/etc/passwd", "a\\b.mp4"]) {
        await assert.rejects(
          () =>
            storage.put({
              key: badKey,
              data: MP4_BYTES,
              mediaType: "video/mp4",
              filename: "clip.mp4",
              signal,
            }),
          TypeError,
          badKey,
        );
      }

      const aborted = new AbortController();
      aborted.abort(new Error("aborted-disk"));
      await assert.rejects(
        () =>
          storage.put({
            key: "clip.mp4",
            data: MP4_BYTES,
            mediaType: "video/mp4",
            filename: "clip.mp4",
            signal: aborted.signal,
          }),
        /aborted-disk/,
      );
      await assert.rejects(
        () => storage.get!({ key: "clip.mp4", signal: aborted.signal }),
        /aborted-disk/,
      );
      await assert.rejects(
        () => storage.delete!({ key: "clip.mp4", signal: aborted.signal }),
        /aborted-disk/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("resolveConfiguredStorage uses localDisk on disk when EVE_DEV=1", async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.EVE_DEV = "1";

    const devStorage = resolveConfiguredStorage(undefined);
    assert.notEqual(devStorage, undefined);

    const signal = new AbortController().signal;
    const key = `test-dev-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`;
    try {
      const stored = await devStorage!.put({
        key,
        data: MP4_BYTES,
        mediaType: "video/mp4",
        filename: key,
        signal,
      });
      assert.equal(typeof stored.path, "string");
      assert.ok(stored.path?.includes("eve-videos"));
      const loaded = await devStorage!.get?.({ key, signal });
      assert.deepEqual(loaded?.data, MP4_BYTES);
    } finally {
      await devStorage!.delete?.({ key, signal });
    }
  });
});
