import { webSearch } from "#public/tools/web-search.js";
import { webFetch } from "#public/tools/web-fetch.js";

export const parallelSearch = webSearch({ provider: "parallel" });
export const exaSearch = webSearch({ provider: "exa" });
export const localFetch = webFetch;
