import type { GeistdocsMarkdownRoute } from "@vercel/geistdocs/proxy";

export const markdownRoutes: GeistdocsMarkdownRoute[] = [
  { from: "/changelog/page/*path", to: "/[lang]/changelog-pages.mdx/*path" },
  { from: "/changelog", to: "/[lang]/changelog.md" },
  { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
  { from: "/integrations/*path", to: "/[lang]/llms.mdx/integrations/*path" },
];
