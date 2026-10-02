import { none } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

// Fixture-only public access so the MCP eval needs no injected credentials.
export default mcpChannel({ auth: none() });
