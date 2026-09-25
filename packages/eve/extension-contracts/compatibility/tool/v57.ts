// Existing callbacks remain valid when the runtime supplies session.context.
import { defineTool } from "#public/tools/index.js";
export default defineTool({
  description: "Read the active session identity.",
  inputSchema: { type: "object", properties: {} },
  execute: (_, ctx) => ({ sessionId: ctx.session.id, turnId: ctx.session.turn.id }),
});
