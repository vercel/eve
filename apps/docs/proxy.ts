import { createProxy } from "@vercel/geistdocs/proxy";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";

const proxy = createProxy({
  config: geistdocsConfig,
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
