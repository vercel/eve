import { getIntegration } from "@/lib/integrations/data";
import { integrationMarkdown } from "@/lib/integrations/markdown";

/**
 * Markdown rendition of an integration detail page. The proxy rewrites
 * `/integrations/<slug>.md` (and AI-agent or Accept-negotiated requests for
 * `/integrations/<slug>`) here.
 */

export const revalidate = false;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(integrationMarkdown(integration), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
