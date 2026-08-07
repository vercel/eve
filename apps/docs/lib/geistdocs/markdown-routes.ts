import type { GeistdocsMarkdownRoute } from "@vercel/geistdocs/proxy";

export const markdownRoutes: GeistdocsMarkdownRoute[] = [
  { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
  { from: "/integrations/*path", to: "/[lang]/llms.mdx/integrations/*path" },
];
