import { defineDynamic } from "eve/tools";
import { definitions, mode } from "../lib/arms";
export default defineDynamic({
  events: { "session.started": () => (mode === "subagents" ? {} : definitions()) },
});
