import { createLlmsRoute } from "@vercel/geistdocs/routes/llms";
import { supportedLanguages } from "@/lib/geistdocs/languages";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { integrationSource } from "@/lib/integrations/source";

const llmsRoute = createLlmsRoute({
  sources: [geistdocsSource, integrationSource],
});

export const GET = llmsRoute.GET;
export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));
