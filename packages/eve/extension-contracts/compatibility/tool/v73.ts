import { webSearch } from "#public/tools/web-search.js";

export const parallelSearch = webSearch({ provider: "parallel" });
export const exaSearch = webSearch({ provider: "exa" });
