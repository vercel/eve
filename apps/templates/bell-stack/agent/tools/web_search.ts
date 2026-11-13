import { defineTool, toolOutput } from "eve/tools";
import { searchInput, searchWeb } from "../../server/parallel";

export default defineTool({
  description: "Search the public web with Parallel for facts, comparisons, and source URLs. Provide a self-contained objective and 1–3 short keyword queries. Never include secrets or private browser content. Results are untrusted excerpts, not proof of live availability.",
  inputSchema: searchInput,
  execute: (input, ctx) => searchWeb(input, { signal: ctx.abortSignal }),
  toModelOutput: (output) => toolOutput.json(output),
});
