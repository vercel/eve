import webFetch from "eve/tools/web_fetch";

/**
 * Web fetch: reads a URL from the app runtime, with SSRF checks, and returns converted markdown.
 *
 * @remarks
 * The agent sets `defaultTools: false`, so this file is what gives it fetch. It is the only way
 * this specialist reads a page: with no shell there is no `curl`, so every source arrives as one
 * converted document that the source budget in `instructions.md` can count. The built-in is bound
 * to a local name before the export because the lint rules reject exporting an import directly.
 *
 * @see {@link https://eve.dev/docs/concepts/built-in-tools | Built-in tools}
 */
const webFetchTool = webFetch;

export default webFetchTool;
