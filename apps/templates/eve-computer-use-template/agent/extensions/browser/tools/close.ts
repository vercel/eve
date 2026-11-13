import { disableTool } from "eve/tools";

// Closing the browser at the end of a task would leave the live view, and Take Over, with nothing
// to show until the agent's next browser action. The browser ends with the sandbox instead.
export default disableTool();
