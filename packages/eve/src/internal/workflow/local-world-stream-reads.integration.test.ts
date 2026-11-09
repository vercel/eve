import fs, { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "eve-stream-reads-"));
    chunkDir = join(dataDir, "streams", "chunks", STREAM);
    await mkdir(chunkDir, { recursive: true });
    for (let index = 0; index < CHUNKS; index++) await writeChunk(chunkName(index), false);
    await settle();
    opens = vi.spyOn(fs, "open");
    readdirs = vi.spyOn(fs, "readdir");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
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
