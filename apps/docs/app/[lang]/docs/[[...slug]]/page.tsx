import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage, createPageActions } from "@vercel/geistdocs/pages/docs";
import type { MDXComponents } from "mdx/types";
import { EditOnGithubAction } from "@/components/geistdocs/edit-on-github";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { config } from "@/lib/geistdocs/config";
import { staticOgImage } from "@/lib/geistdocs/og";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";

// Geistdocs owns the page-tree version, which can differ from the docs app's Fumadocs version.
interface SidebarNode {
  children?: SidebarNode[];
  fallback?: SidebarNode;
  index?: SidebarNode;
  name?: unknown;
  type?: string;
  url?: string;
}

const findSidebarParentTitle = (node: SidebarNode, url: string): string | undefined => {
  if (node.index?.type === "page" && node.index.url === url) {
    return typeof node.name === "string" ? node.name : undefined;
  }

  if (node.fallback) {
    const title = findSidebarParentTitle(node.fallback, url);
    if (title !== undefined) return title;
  }

  for (const child of node.children ?? []) {
    if (child.type === "page" && child.url === url) {
      return typeof node.name === "string" ? node.name : undefined;
    }

    const title = findSidebarParentTitle(child, url);
    if (title !== undefined) return title;
  }
};

const docsPage = createDocsPage({
  config,
  pageActions: createPageActions({
    config,
    getExtraActions: ({ page }) =>
      page.path ? [<EditOnGithubAction key="edit-source" path={page.path} />] : [],
  }),
  mdx: ({ link }) => {
    const components: MDXComponents = link ? { a: link } : {};
    return getMDXComponents(components);
  },
  metadata: ({ metadata, page, params }) => {
    const parentTitle =
      page.data.title === "Overview"
        ? findSidebarParentTitle(geistdocsSource.source.getPageTree(params.lang), page.url)
        : undefined;

    return {
      ...metadata,
      title: parentTitle ?? metadata.title,
      metadataBase: new URL(getSiteOrigin()),
      openGraph: {
        ...metadata.openGraph,
        // Override with the static OG image for now. To restore dynamic per-page
        // OG generation, swap the line below back to:
        // images: geistdocsSource.getPageImage(page).url,
        images: [staticOgImage],
      },
    };
  },
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
