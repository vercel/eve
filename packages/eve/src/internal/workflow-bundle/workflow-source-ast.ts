import { inferRolldownParserLanguage, parseWithRolldownAst } from "#internal/bundler/rolldown.js";

const MAX_CACHED_SOURCE_LENGTH = 1024 * 1024;

const cache = new Map<string, unknown>();
let cachedSourceLength = 0;

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
