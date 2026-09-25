import { createAgentsRoute } from "@vercel/geistdocs/routes/agents";
import { transformAgentsMarkdown } from "@/lib/geistdocs/agents-transform";
import { config } from "@/lib/geistdocs/config";
import { templateManifest } from "@/lib/templates/manifest";

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
