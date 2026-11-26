import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { resolveConfiguredStorage } from "../../extension/lib/storage/default.ts";
import { localDisk } from "../../extension/lib/storage/local-disk.ts";
import { MP3_BYTES, MP4_BYTES, withCleanStorageEnv } from "../helpers.ts";

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

      await storage.put({
        key: "audio/track.mp3",
        data: MP3_BYTES,
        mediaType: "audio/mpeg",
        filename: "track.mp3",
        signal,
      });
      const audioRead = await storage.get?.({ key: "audio/track.mp3", signal });
      assert.equal(audioRead?.mediaType, "audio/mpeg");
      assert.deepEqual(audioRead?.data, MP3_BYTES);

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
      await assert.rejects(
        () =>
          storage.put({
            key: "../outside.mp4",
            data: MP4_BYTES,
            mediaType: "video/mp4",
            filename: "clip.mp4",
            signal,
          }),
        TypeError,
      );

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

  test("resolveConfiguredStorage uses localDisk on disk when EVE_DEV=1", () =>
    withCleanStorageEnv(
      async () => {
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
      },
      { EVE_DEV: "1" },
    ));
});
