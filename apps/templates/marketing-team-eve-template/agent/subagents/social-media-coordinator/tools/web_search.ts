import { webSearch } from "eve/tools/web_search";

/**
 * Web search, run by Exa through the AI Gateway.
 *
 * @remarks
 * The agent sets `defaultTools: false`, so this file is what gives it search. Exa is the provider
 * eve uses for Gateway models when none is named; it is stated here so a change of provider is a
 * deliberate edit.
 *
 * @see {@link https://eve.dev/docs/concepts/built-in-tools | Built-in tools}
 */
export default webSearch({ provider: "exa" });
