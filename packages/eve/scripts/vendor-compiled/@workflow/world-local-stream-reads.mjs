/**
 * Makes @workflow/world-local stream reads cost O(new chunks) instead of
 * O(all chunks) per call within one process (vercel/eve#3168).
 *
 * Upstream lists a stream's chunk directory and opens every chunk file on each
 * `getInfo`, `getChunks` and live-poll call, so a tail lookup on a 50k-chunk
 * stream opens 50k files. Chunk files are written once (temp file + rename) and
 * never change, so this transform:
 *
 * - caches the sorted listing per (directory, tag), reused only while the
 *   directory's dev/ino/size/mtime/ctime are unchanged and its mtime is older
 *   than the listing by more than the mtime granularity margin, so a chunk
 *   landing in the same mtime tick is never missed;
 * - remembers which physical chunk files are known not to be EOF, so the
 *   first-EOF walk in `getInfo`, `getChunks` and `get(-n)` opens only files it
 *   has not seen. The walk itself is unchanged: sorted order, first EOF ends the
 *   stream, nothing past it is opened. The purge tombstone is rewritten in
 *   place and is never remembered.
 *
 * Every replacement is an exact match that must occur the expected number of
 * times, so a changed upstream file fails the vendor build.
 */

const STREAMER_ID = "/@workflow/world-local/dist/streamer.js";

const CACHE_SOURCE = `
// eve: stream read caches (vercel/eve#3168).
const STREAM_READ_CACHE_DIRECTORIES = 256;
// Directory mtimes can be as coarse as 2 s; a listing taken within that margin
// of the last change may predate an entry with the same mtime.
const STREAM_LISTING_MTIME_MARGIN_NS = 2000000000n;
const streamListingCache = new Map();
const streamNonEofChunks = new Map();
function rememberStreamReadEntry(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > STREAM_READ_CACHE_DIRECTORIES)
        map.delete(map.keys().next().value);
}
function clearStreamReadCaches() {
    streamListingCache.clear();
    streamNonEofChunks.clear();
}
async function statChunkDir(dir) {
    try {
        return await fs.stat(dir, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function sameChunkDirStat(a, b) {
    return (a.dev === b.dev &&
        a.ino === b.ino &&
        a.size === b.size &&
        a.mtimeNs === b.mtimeNs &&
        a.ctimeNs === b.ctimeNs);
}
async function listChunkFilesForStream(chunksBaseDir, name, tag) {
    const dir = chunkDirForStream(chunksBaseDir, name);
    const key = \`\${dir}\\0\${tag ?? ''}\`;
    const stat = await statChunkDir(dir);
    const cached = streamListingCache.get(key);
    if (stat && cached && sameChunkDirStat(cached.stat, stat))
        return cached.listing;
    const listedAtNs = BigInt(Date.now()) * 1000000n;
    const listing = await listChunkFilesForStreamUncached(chunksBaseDir, name, tag);
    if (stat && stat.mtimeNs + STREAM_LISTING_MTIME_MARGIN_NS < listedAtNs) {
        rememberStreamReadEntry(streamListingCache, key, { stat, listing });
    }
    else {
        streamListingCache.delete(key);
    }
    return listing;
}
function rememberNonEofChunk(dir, physicalName) {
    if (physicalName.startsWith(PURGED_STREAM_TOMBSTONE_ID))
        return;
    let known = streamNonEofChunks.get(dir);
    if (!known) {
        known = new Set();
        rememberStreamReadEntry(streamNonEofChunks, dir, known);
    }
    known.add(physicalName);
}
async function isEofChunkFile(dir, physicalName) {
    if (streamNonEofChunks.get(dir)?.has(physicalName))
        return false;
    const eof = isEofByte(await readFirstByte(path.join(dir, physicalName)));
    if (!eof)
        rememberNonEofChunk(dir, physicalName);
    return eof;
}
`;

const REPLACEMENTS = [
  {
    from: "async function listChunkFilesForStream(chunksBaseDir, name, tag) {",
    to: "async function listChunkFilesForStreamUncached(chunksBaseDir, name, tag) {",
  },
  {
    from: "const PURGED_STREAM_TOMBSTONE_ID = `chnk_${'0'.repeat(26)}`;",
    to: "const PURGED_STREAM_TOMBSTONE_ID = `chnk_${'0'.repeat(26)}`;" + CACHE_SOURCE,
  },
  {
    from: "        clearCache() {\n            registeredStreams.clear();",
    to: "        clearCache() {\n            registeredStreams.clear();\n            clearStreamReadCaches();",
  },
  {
    // getChunks: the walk before the cursor and the peek past the page.
    from: "if (isEofByte(await readFirstByte(filePath))) {",
    to: "if (await isEofChunkFile(chunksDir, `${file}${ext}`)) {",
    count: 2,
  },
  {
    from: "                    resultChunks.push({\n                        index: dataIndex,",
    to: "                    rememberNonEofChunk(chunksDir, `${file}${ext}`);\n                    resultChunks.push({\n                        index: dataIndex,",
  },
  {
    // getInfo.
    from: "if (isEofByte(await readFirstByte(path.join(chunksDir, `${file}${ext}`)))) {",
    to: "if (await isEofChunkFile(chunksDir, `${file}${ext}`)) {",
  },
  {
    // get() with a negative start index.
    from: "if (isEofByte(await readFirstByte(path.join(chunksDir, `${lastFile}${lastExt}`)))) {",
    to: "if (await isEofChunkFile(chunksDir, `${lastFile}${lastExt}`)) {",
  },
];

export function transformWorkflowWorldLocalStreamer(source) {
  let code = source;
  for (const { from, to, count = 1 } of REPLACEMENTS) {
    const found = code.split(from).length - 1;
    if (found !== count) {
      throw new Error(
        `@workflow/world-local streamer.js: expected ${count} match(es) of ${JSON.stringify(from.slice(0, 80))}, found ${found}.`,
      );
    }
    code = code.replaceAll(from, to);
  }
  return code;
}

export const workflowWorldLocalStreamReadPlugin = {
  name: "eve-workflow-world-local-stream-reads",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith(STREAMER_ID)) {
      return undefined;
    }
    return { code: transformWorkflowWorldLocalStreamer(source), map: null };
  },
};
