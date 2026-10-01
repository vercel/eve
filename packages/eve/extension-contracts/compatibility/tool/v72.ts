// Existing callbacks remain valid when message.received carries clientContext.
import { defineTool } from "#public/tools/index.js";
export default defineTool({
  description: "Read the active session identity.",
  inputSchema: { type: "object", properties: {} },
  execute: (_, ctx) => ({ sessionId: ctx.session.id, turnId: ctx.session.turn.id }),
});
