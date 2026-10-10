import { defaultWebSearch, webSearch } from "#public/tools/web-search.js";

export const defaultSearch = defaultWebSearch;
export const exaSearch = webSearch({ provider: "exa" });
export const parallelSearch = webSearch({ provider: "parallel" });
