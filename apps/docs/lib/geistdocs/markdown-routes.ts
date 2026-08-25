import type { CreateProxyOptions, GeistdocsMarkdownRoute } from "@vercel/geistdocs/proxy";

export const markdownRoutes: GeistdocsMarkdownRoute[] = [
  { from: "/docs/*path", to: "/[lang]/llms.mdx/*path" },
  { from: "/integrations/*path", to: "/[lang]/llms.mdx/integrations/*path" },
];

// Route families with valid HTML pages but no Markdown mapping. Agents and
// Markdown requests to unmatched paths elsewhere get a recoverable Markdown
// 404 (geistdocs `markdownNotFound`); these families continue to the app so
// their consumer-owned HTML responses stay intact.
const htmlOnlyRouteFamilies = ["/templates", "/benchmarks", "/resources"];

type MarkdownNotFoundPredicate = Extract<
  CreateProxyOptions["markdownNotFound"],
  (context: never) => boolean
>;

export const markdownNotFound: MarkdownNotFoundPredicate = ({ pathname }) =>
  !htmlOnlyRouteFamilies.some((family) => pathname === family || pathname.startsWith(`${family}/`));
