import { createLlmsRoute } from "@vercel/geistdocs/routes/llms";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

export const revalidate = false;

const llmsRoute = createLlmsRoute({
  sources: [geistdocsSource, integrationSource],
});

export const GET = llmsRoute.GET;
