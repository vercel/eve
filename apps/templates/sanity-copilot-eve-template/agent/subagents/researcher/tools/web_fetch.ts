import webFetch from "eve/tools/web_fetch";

/**
 * Web fetch for the researcher: reads a URL from the app runtime, with SSRF checks.
 *
 * @remarks
 * The researcher sets `defaultTools: false`, so this file is what gives it fetch. The built-in
 * is bound to a local constant because the lint preset rejects both exporting an import
 * directly and a bare `export … from`.
 */
const webFetchTool = webFetch;

export default webFetchTool;
