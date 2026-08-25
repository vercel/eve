import { webSearch, type WebSearchToolDefinition } from "#public/tools/index.js";

// Epoch 17 callers always pass a provider and read it back off the sentinel.
const definition: WebSearchToolDefinition = webSearch({ provider: "parallel" });
void definition.provider;

export default definition;
