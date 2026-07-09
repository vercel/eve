import { createProxy } from "@vercel/geistdocs/proxy";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";

const proxy = createProxy({
  config: geistdocsConfig,
  // Replicates the route geistdocs infers for `/docs`, plus markdown
  // renditions of integration detail pages (`/integrations/<slug>.md`,
  // AI-agent rewrites, and Accept-header negotiation).
  markdownRoutes: [
    { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
    { from: "/integrations/*path", to: "/[lang]/integrations-md/*path" },
  ],
  trackMarkdownRequest: trackMdRequest,
  before: () => null,
});

export const config = {
  // Matcher ignoring `/_next/`, `/api/`, public static assets, favicon, sitemap, robots, etc.
  matcher: [
    "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|eve\\.tgz$|.*\\.(?!mdx?$)[^/]+$).*)",
  ],
};

export default proxy;
