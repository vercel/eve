import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up a project by ID.",
  inputSchema: z.object({ projectId: z.string() }),
  async execute({ projectId }, ctx) {
    const response = await fetch(
      `https://api.example.com/projects/${encodeURIComponent(projectId)}`,
      {
        headers: { authorization: `Bearer ${process.env.PROJECTS_API_TOKEN}` },
        signal: ctx.abortSignal,
      },
    );
    if (!response.ok) throw new Error(`Projects API returned ${response.status}`);
    return response.json();
  },
});
