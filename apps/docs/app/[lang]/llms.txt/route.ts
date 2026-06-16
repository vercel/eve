import { createLlmsRoute } from "@vercel/geistdocs/routes/llms";
import { geistdocsSource } from "@/lib/geistdocs/source";

export const revalidate = false;

const llmsRoute = createLlmsRoute({
  sources: [geistdocsSource],
});

export const GET = llmsRoute.GET;
