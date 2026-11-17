import { catalogTool } from "../lib/catalog";

/** Lets the agent take an accessibility-tree snapshot of the page with reusable element refs for later actions. */
export default catalogTool("snapshot", { retryOnCdpError: true });
