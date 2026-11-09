import { createAgentsRoute } from "@vercel/geistdocs/routes/agents";
import { transformAgentsMarkdown } from "@/lib/geistdocs/agents-transform";
import { config } from "@/lib/geistdocs/config";

const agentsRoute = createAgentsRoute({
  config,
  transform: (markdown, { request }) =>
    transformAgentsMarkdown(markdown, {
      origin: request.nextUrl.origin,
    }),
});

export const GET = agentsRoute.GET;
export const generateStaticParams = agentsRoute.generateStaticParams;
