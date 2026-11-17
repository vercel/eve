import { catalogTool } from "../lib/catalog";

/** Lets the agent read, and optionally clear, the page errors captured in the session. Deferred: the agent finds it with tool search. */
export default catalogTool("errors", { deferred: true });
