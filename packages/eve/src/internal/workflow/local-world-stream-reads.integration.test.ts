import fs, { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorld } from "#compiled/@workflow/world-local/index.js";

const RUN_ID = "wrun_streamreads";
const STREAM = "strm_streamreads";
const CHUNKS = 5_000;

function chunkName(index: number): string {
  return `chnk_A${String(index).padStart(25, "0")}`;
}

function cursorAt(index: number): string {
  return Buffer.from(JSON.stringify({ i: index })).toString("base64");
}

describe("local world stream reads", () => {
  let dataDir: string;
  let chunkDir: string;
  let opens: ReturnType<typeof vi.spyOn>;
  let readdirs: ReturnType<typeof vi.spyOn>;

  async function writeChunk(name: string, eof: boolean): Promise<void> {
    await writeFile(join(chunkDir, `${name}.bin`), Buffer.from(eof ? [1] : [0, 120]));
  }

  /** The chunks every test starts from, by file name. */
  const baseChunkFiles = new Set(
    Array.from({ length: CHUNKS }, (_unused, index) => `${chunkName(index)}.bin`),
  );

  // Back-date the directory past the listing cache's mtime margin, as for a stream
  // that has not been written to for a few seconds.
  async function settle(): Promise<void> {
    const past = new Date(Date.now() - 60_000);
    await utimes(chunkDir, past, past);
  }

  function resetCounts(): void {
    opens.mockClear();
    readdirs.mockClear();
  }

  // The base stream is large, and every test starts from it unchanged, so it is written once
  // rather than per test. A test that appends chunks leaves them for the next test's cleanup.
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "eve-stream-reads-"));
    chunkDir = join(dataDir, "streams", "chunks", STREAM);
    await mkdir(chunkDir, { recursive: true });
    const names = [...baseChunkFiles];
    for (let start = 0; start < names.length; start += 64) {
      await Promise.all(
        names
          .slice(start, start + 64)
          .map((name) => writeChunk(name.slice(0, -".bin".length), false)),
      );
    }
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const appended = (await readdir(chunkDir)).filter((name) => !baseChunkFiles.has(name));
    await Promise.all(appended.map((name) => rm(join(chunkDir, name), { force: true })));
    await settle();
    opens = vi.spyOn(fs, "open");
    readdirs = vi.spyOn(fs, "readdir");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a repeated tail lookup on an unchanged stream without reopening chunks", async () => {
    const streams = createWorld({ dataDir }).streams;

    expect(await streams.getInfo(RUN_ID, STREAM)).toEqual({ tailIndex: CHUNKS - 1, done: false });
    expect(opens).toHaveBeenCalledTimes(CHUNKS);

    resetCounts();
    expect(await streams.getInfo(RUN_ID, STREAM)).toEqual({ tailIndex: CHUNKS - 1, done: false });
    expect(opens).toHaveBeenCalledTimes(0);
    expect(readdirs).toHaveBeenCalledTimes(0);
  });

  it("opens only the new chunks when another process appends to the stream", async () => {
    const streams = createWorld({ dataDir }).streams;
    await streams.getInfo(RUN_ID, STREAM);

    await writeChunk(chunkName(CHUNKS), false);
    await writeChunk(chunkName(CHUNKS + 1), true);
    resetCounts();

    expect(await streams.getInfo(RUN_ID, STREAM)).toEqual({ tailIndex: CHUNKS, done: true });
    expect(readdirs).toHaveBeenCalledTimes(1);
    expect(opens).toHaveBeenCalledTimes(2);
  });

  it("ends the stream at an EOF chunk that lands below chunks already seen", async () => {
    const streams = createWorld({ dataDir }).streams;
    await streams.getInfo(RUN_ID, STREAM);

    // Sorts between chunk 9 and chunk 10, like a close() whose id was taken before
    // later writes landed, or the all-zero purge tombstone.
    await writeChunk(`${chunkName(9)}0`, true);
    resetCounts();

    expect(await streams.getInfo(RUN_ID, STREAM)).toEqual({ tailIndex: 9, done: true });
    expect(opens).toHaveBeenCalledTimes(1);
    const page = await streams.getChunks(RUN_ID, STREAM, { cursor: cursorAt(5) });
    expect(page.data.map((chunk) => chunk.index)).toEqual([5, 6, 7, 8, 9]);
    expect(page.done).toBe(true);
  });

  it("seeks to a cursor without reopening chunks before it", async () => {
    const streams = createWorld({ dataDir }).streams;
    await streams.getInfo(RUN_ID, STREAM);
    resetCounts();

    const page = await streams.getChunks(RUN_ID, STREAM, {
      cursor: cursorAt(CHUNKS - 3),
      limit: 2,
    });
    expect(page.data.map((chunk) => chunk.index)).toEqual([CHUNKS - 3, CHUNKS - 2]);
    expect(page.hasMore).toBe(true);
    expect(page.done).toBe(false);
    expect(opens).toHaveBeenCalledTimes(0);
    expect(readdirs).toHaveBeenCalledTimes(0);
  });

  it("re-lists a directory that changed within the mtime margin", async () => {
    const streams = createWorld({ dataDir }).streams;
    await writeChunk(chunkName(CHUNKS), false);
    await streams.getInfo(RUN_ID, STREAM);
    resetCounts();

    await streams.getInfo(RUN_ID, STREAM);
    expect(readdirs).toHaveBeenCalledTimes(1);
    expect(opens).toHaveBeenCalledTimes(0);
  });
});
