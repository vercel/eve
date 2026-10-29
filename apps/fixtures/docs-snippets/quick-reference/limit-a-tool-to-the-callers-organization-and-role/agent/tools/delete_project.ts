import { defineTool } from "eve/tools";
import { z } from "zod";
import { deleteProject } from "../../lib/projects";

export default defineTool({
  description: "Permanently delete one of the organization's projects. Owners only.",
  inputSchema: z.object({ projectId: z.string() }),
  approval: ({ session }) =>
    session.auth.current?.attributes.role === "owner"
      ? "user-approval"
      : { type: "denied", reason: "Only organization owners can delete projects." },
  async execute({ projectId }, ctx) {
    const { orgId, role } = ctx.session.auth.current?.attributes ?? {};
    if (typeof orgId !== "string" || role !== "owner") {
      throw new Error("Only organization owners can delete projects.");
    }
    return deleteProject({ orgId, projectId });
  },
});
