import { inferRolldownParserLanguage, parseWithRolldownAst } from "#internal/bundler/rolldown.js";

// A cached tree costs about 20 bytes of heap per source character. 1 MiB of source keeps every
// repeated parse of a typical build while bounding what a long `eve dev` session retains.
const MAX_CACHED_SOURCE_LENGTH = 1024 * 1024;

const cache = new Map<string, unknown>();
let cachedSourceLength = 0;

/**
 * Parses each source once per process and parser language: discovery, the driver, the step
 * bundle, and the step manifest all transform the same modules. Callers share the tree, so they
 * must only read it. A parse error is never cached, so it is raised again on every call.
 */
export async function parseWorkflowSourceAst(filename: string, source: string): Promise<unknown> {
  const key = `${inferRolldownParserLanguage(filename)}\0${source}`;
  if (cache.has(key)) {
    const ast = cache.get(key);
    cache.delete(key);
    cache.set(key, ast);
    return ast;
  }
  const ast = await parseWithRolldownAst(filename, source);
  if (key.length > MAX_CACHED_SOURCE_LENGTH || cache.has(key)) return ast;
  cache.set(key, ast);
  cachedSourceLength += key.length;
  for (const cachedKey of cache.keys()) {
    if (cachedSourceLength <= MAX_CACHED_SOURCE_LENGTH) break;
    cache.delete(cachedKey);
    cachedSourceLength -= cachedKey.length;
  }
  return ast;
}
