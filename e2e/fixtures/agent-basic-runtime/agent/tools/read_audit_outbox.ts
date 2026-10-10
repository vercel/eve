import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { auditOutbox, isWorkspaceMember } from "../lib/workspace";

// Only workspace members have an audit outbox, so other callers never see this tool.
export default defineDynamic({
  select: (view) => view.latest["model.requested"] ?? null,
  resolve: (_event, ctx) =>
    isWorkspaceMember(ctx.session.auth.current)
      ? defineTool({
          description: "List audit events waiting for the workspace audit sink.",
          inputSchema: z.strictObject({}),
          async execute() {
            return auditOutbox.get();
          },
        })
      : null,
});
