function replaceSourceOrThrow(source, match, replacement, description) {
  if (!source.includes(match)) {
    throw new Error(`Failed to patch @workflow/world-local ${description}.`);
  }
  return source.replace(match, replacement);
}

export const workflowWorldLocalStreamReadPlugin = {
  name: "eve-workflow-world-local-stream-reads",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/@workflow/world-local/dist/streamer.js")) {
      return undefined;
    }

    let code = replaceSourceOrThrow(
      source,
      "const EOF_MARKER = 1;",
      `const EOF_MARKER = 1;
const CHUNK_FILE_LIST_CACHE_TTL_MS = 2000;
const chunkFileListCache = globalSingleton('@workflow/world-local//streamerChunkFileLists/eve', 1, () => new Map());
async function getChunkDirectoryVersion(dir) {
    try {
        const stats = await fs.stat(dir, { bigint: true });
        return \`\${stats.dev}:\${stats.ino}:\${stats.size}:\${stats.mtimeNs}:\${stats.ctimeNs}\`;
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
            return 'missing';
        }
        throw error;
    }
}`,
      "chunk-list cache state",
    );
    code = replaceSourceOrThrow(
      code,
      `async function listChunkFilesForStream(chunksBaseDir, name, tag) {
    const dir = chunkDirForStream(chunksBaseDir, name);
    const entries = await listChunkEntries(dir);
    const extMap = new Map();
    addChunkFilesByExtension(extMap, entries, '.json');
    addChunkFilesByExtension(extMap, entries, '.bin', '.bin', tag ? (file) => !file.endsWith(\`.\${tag}\`) : undefined);
    if (tag) {
        const taggedExtension = \`.\${tag}.bin\`;
        addChunkFilesByExtension(extMap, entries, taggedExtension);
    }
    const files = [...extMap.keys()].sort();
    return { files, extMap, dir };
}`,
      `async function listChunkFilesForStream(chunksBaseDir, name, tag) {
    const dir = chunkDirForStream(chunksBaseDir, name);
    const cacheKey = \`\${dir}\\0\${tag ?? ''}\`;
    const directoryVersion = await getChunkDirectoryVersion(dir);
    const cached = chunkFileListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() && cached.directoryVersion === directoryVersion) {
        return cached.listing;
    }
    const listing = (async () => {
        const entries = await listChunkEntries(dir);
        const extMap = new Map();
        addChunkFilesByExtension(extMap, entries, '.json');
        addChunkFilesByExtension(extMap, entries, '.bin', '.bin', tag ? (file) => !file.endsWith(\`.\${tag}\`) : undefined);
        if (tag) {
            const taggedExtension = \`.\${tag}.bin\`;
            addChunkFilesByExtension(extMap, entries, taggedExtension);
        }
        const files = [...extMap.keys()].sort();
        return { files, extMap, dir };
    })();
    const entry = {
        directoryVersion,
        expiresAt: Date.now() + CHUNK_FILE_LIST_CACHE_TTL_MS,
        listing,
    };
    chunkFileListCache.set(cacheKey, entry);
    setTimeout(() => {
        if (chunkFileListCache.get(cacheKey) === entry) {
            chunkFileListCache.delete(cacheKey);
        }
    }, CHUNK_FILE_LIST_CACHE_TTL_MS).unref();
    try {
        return await listing;
    }
    catch (error) {
        if (chunkFileListCache.get(cacheKey) === entry) {
            chunkFileListCache.delete(cacheKey);
        }
        throw error;
    }
}`,
      "chunk-list cache",
    );
    code = replaceSourceOrThrow(
      code,
      "                        startIndex = decoded.i;",
      "                        startIndex = Number.isSafeInteger(decoded.i) && decoded.i >= 0 ? decoded.i : 0;",
      "stream cursor validation",
    );
    code = replaceSourceOrThrow(
      code,
      `                let dataIndex = 0; // running count of data (non-EOF) files seen
                for (const file of chunkFiles) {
                    const ext = fileExtMap.get(file) ?? '.bin';
                    const filePath = path.join(chunksDir, \`\${file}\${ext}\`);
                    // Before the cursor: only need to check EOF (1 byte), skip content
                    if (dataIndex < startIndex) {
                        if (isEofByte(await readFirstByte(filePath))) {
                            streamDone = true;
                            break;
                        }
                        dataIndex++;
                        continue;
                    }`,
      `                let dataIndex = startIndex;
                for (let fileIndex = startIndex; fileIndex < chunkFiles.length; fileIndex++) {
                    const file = chunkFiles[fileIndex];
                    const ext = fileExtMap.get(file) ?? '.bin';
                    const filePath = path.join(chunksDir, \`\${file}\${ext}\`);`,
      "cursor seek",
    );
    return { code, map: null };
  },
};
