import { createProxy } from "@vercel/geistdocs/proxy";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";

const proxy = createProxy({
  config: geistdocsConfig,
  trackMarkdownRequest: trackMdRequest,
  before: () => null,
});

export const config = {
  // llms.txt needs the locale rewrite even though the general matcher ignores static extensions.
  matcher: [
    "/llms.txt",
    "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|eve\\.tgz$|.*\\.(?!mdx?$)[^/]+$).*)",
  ],
};

export default proxy;
