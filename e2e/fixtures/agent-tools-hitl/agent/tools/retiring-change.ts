import { defineDynamic, defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

/**
 * A step-scoped tool offered only while the caller's fixture flag is not
 * "retire", for proving an approved call keeps the tools of the step that
 * asked even when a later step would not offer this one.
 */
export default defineDynamic({
  select: (view) => view.latest["model.requested"] ?? null,
  resolve: (_event, ctx) =>
    ctx.session.auth.current?.attributes?.flag === "retire"
      ? null
      : defineTool({
          description: "Apply the retiring fixture change after approval.",
          inputSchema: z.object({}),
          approval: always(),
          execute: () => ({ change: "retiring" }),
        }),
});
