import { createSearchRoute } from "@vercel/geistdocs/routes/search";
import { config } from "@/lib/geistdocs/config";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

export const GET = createSearchRoute({
  config,
  sources: [geistdocsSource, integrationSource],
});
