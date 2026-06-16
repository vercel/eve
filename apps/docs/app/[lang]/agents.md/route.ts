import { createAgentsRoute } from "@vercel/geistdocs/routes/agents";
import { config } from "@/lib/geistdocs/config";

// Static, CDN-cacheable. /agents.md surfaces the agent instructions from the
// Geistdocs config and points agents at /llms.txt and individual /llms.mdx
// pages. Keeping this route prerendered avoids a per-request function on an
// endpoint crawlers and agents poll repeatedly.
export const revalidate = false;

const agentsRoute = createAgentsRoute({ config });

export const GET = agentsRoute.GET;
export const generateStaticParams = agentsRoute.generateStaticParams;
