import { createProxy } from "@vercel/geistdocs/proxy";
import type { NextFetchEvent, NextRequest } from "next/server";
import { config as geistdocsConfig } from "@/lib/geistdocs/config";
import { removeProxyMarkdownCanonical } from "@/lib/geistdocs/markdown-canonical";
import { markdownRoutes } from "@/lib/geistdocs/markdown-routes";
import { trackMdRequest } from "@/lib/geistdocs/md-tracking";

const geistdocsProxy = createProxy({
  config: geistdocsConfig,
  markdownRoutes,
  trackMarkdownRequest: trackMdRequest,
  before: () => null,
});

const proxy = async (request: NextRequest, context: NextFetchEvent) =>
  removeProxyMarkdownCanonical(await geistdocsProxy(request, context));

export const config = {
  // These routes need the locale rewrite even though the general matcher ignores static extensions.
  matcher: [
    "/llms.txt",
    "/llms-full.txt",
    "/rss.xml",
    "/((?!api(?:/|$)|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|eve\\.tgz$|.*\\.(?!mdx?$)[^/]+$).*)",
  ],
};

export default proxy;
