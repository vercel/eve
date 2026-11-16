import { defineTool } from "eve/tools";
import { z } from "zod";

const projects = ["web", "api", "docs", "dashboard", "edge-config"];
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Deterministic sample data so the demo looks the same every run.
function sample(seed: number): number {
  const x = Math.sin(seed) * 10_000;
  return x - Math.floor(x);
}

export default defineTool({
  description:
    "Get last week's deployment stats for the team: per-project deploy counts, failure rates, build times, and deploys per day.",
  inputSchema: z.object({
    team: z.string().default("acme").describe("Team slug."),
  }),
  async execute({ team }) {
    const perProject = projects.map((project, i) => {
      const deploys = 40 + Math.round(sample(i + 1) * 400);
      const failed = Math.round(deploys * (0.01 + sample(i + 11) * 0.06));
      return {
        project,
        deploys,
        failed,
        p50BuildSeconds: 30 + Math.round(sample(i + 21) * 120),
      };
    });
    const perDay = days.map((day, i) => ({
      day,
      production: 20 + Math.round(sample(i + 31) * 120),
      preview: 60 + Math.round(sample(i + 41) * 220),
    }));
    return {
      team,
      range: "Oct 27 to Nov 2",
      totalDeploys: perProject.reduce((sum, p) => sum + p.deploys, 0),
      totalFailed: perProject.reduce((sum, p) => sum + p.failed, 0),
      perProject,
      perDay,
      dashboardUrl: `https://vercel.com/${team}/~/deployments`,
    };
  },
});
