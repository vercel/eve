import { webSearch } from "#public/tools/web-search.js";

// Epoch 82 web search accepted only exa, parallel, and browserbase; epoch 83
// adds provider "openai" with an optional fallback. Existing selections keep working.
export default webSearch({ provider: "parallel" });
