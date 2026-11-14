import { promises as fs } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local Workflow stream pagination", () => {
  it("reuses a chunk listing and skips files before the cursor", async () => {
    const dataDir = await createScratchDirectory("eve-local-world-stream-");
    const chunksDir = join(dataDir, "streams", "chunks", "test-stream");
    await mkdir(chunksDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        writeFile(
          join(chunksDir, `chnk_${String(index).padStart(4, "0")}.bin`),
          Uint8Array.of(0, index % 255),
        ),
      ),
    );
    await writeFile(join(chunksDir, "chnk_0050.bin"), Uint8Array.of(1));

    const readdir = vi.spyOn(fs, "readdir");
    const open = vi.spyOn(fs, "open");
    const world = createWorld({ dataDir, recoverActiveRuns: false });

    try {
      const firstPage = await world.streams.getChunks("ignored-run", "test-stream", {
        limit: 40,
      });
      expect(firstPage.hasMore).toBe(true);
      expect(firstPage.cursor).not.toBeNull();

      open.mockClear();
      const secondPage = await world.streams.getChunks("ignored-run", "test-stream", {
        cursor: firstPage.cursor ?? undefined,
        limit: 10,
      });

      expect(secondPage.data).toHaveLength(10);
      expect(secondPage.done).toBe(true);
      expect(secondPage.hasMore).toBe(false);
      expect(readdir).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);

      await rm(chunksDir, { recursive: true });
      await expect(world.streams.getChunks("ignored-run", "test-stream")).resolves.toMatchObject({
        data: [],
        done: false,
        hasMore: false,
      });
      expect(readdir).toHaveBeenCalledTimes(2);
    } finally {
      await world.close?.();
    }
  });

  it("refreshes a live reader when another process writes a chunk", async () => {
    const dataDir = await createScratchDirectory("eve-local-world-live-stream-");
    const chunksDir = join(dataDir, "streams", "chunks", "live-stream");
    const readdir = vi.spyOn(fs, "readdir");
    const world = createWorld({ dataDir, recoverActiveRuns: false });
    const stream = await world.streams.get("ignored-run", "live-stream");
    const reader = stream.getReader();

    try {
      await vi.waitFor(() => expect(readdir).toHaveBeenCalledTimes(1));
      await mkdir(chunksDir, { recursive: true });
      await writeFile(join(chunksDir, "chnk_0000.bin"), Uint8Array.of(0, 42));

      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: Uint8Array.of(42),
      });
      expect(readdir).toHaveBeenCalledTimes(2);
    } finally {
      await reader.cancel();
      await world.close?.();
    }
  });
});
