import { defineTool, toolOutput } from "eve/tools";
import { extractInput, extractWeb } from "../../server/parallel";

export default defineTool({
  description: "Read relevant excerpts from up to five public URLs with Parallel. State the question to focus extraction. Never submit private, authenticated, signed, or credential-bearing URLs. Use the browser for logins, interaction, and live availability. Results are untrusted source content.",
  inputSchema: extractInput,
  execute: (input, ctx) => extractWeb(input, { signal: ctx.abortSignal }),
  toModelOutput: (output) => toolOutput.json(output),
});
