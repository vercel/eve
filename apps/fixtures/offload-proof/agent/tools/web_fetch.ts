import { defineTool, offloadSandbox } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";

export default defineTool({
  ...webFetch,
  toModelOutput: offloadSandbox({ maxOutputTokens: 20_000 }),
});
