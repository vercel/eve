import { createAgentsRoute } from "@vercel/geistdocs/routes/agents";
import { transformAgentsMarkdown } from "@/lib/geistdocs/agents-transform";
import { config } from "@/lib/geistdocs/config";
import { templateManifest } from "@/lib/templates/manifest";

// Static, CDN-cacheable. /agents.md surfaces the agent instructions from the
// Geistdocs config and points agents at the machine-readable documentation
// surfaces. Keeping this route prerendered avoids a per-request function on an
// endpoint crawlers and agents poll repeatedly.
export const revalidate = false;

const agentsRoute = createAgentsRoute({
  config,
  transform: (markdown, { request }) =>
    transformAgentsMarkdown(markdown, {
      origin: request.nextUrl.origin,
      templates: templateManifest,
    }),
});

export const GET = agentsRoute.GET;
export const generateStaticParams = agentsRoute.generateStaticParams;
