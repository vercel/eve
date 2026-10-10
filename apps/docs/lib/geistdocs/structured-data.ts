import { defaultLanguage } from "./languages";
import { siteName } from "./metadata-title";
import { getSiteOrigin } from "./url";

type JsonLdNode = Record<string, unknown>;

export interface BreadcrumbEntry {
  name: string;
  /** Site-relative pathname. */
  pathname: string;
}

/** Serializes JSON-LD for an inline script, escaping `<` so content cannot close the tag. */
export const serializeJsonLd = (data: JsonLdNode): string =>
  JSON.stringify(data).replace(/</g, "\\u003c");

const absoluteUrl = (pathname: string): string => new URL(pathname, getSiteOrigin()).toString();

const publisher = (): JsonLdNode => ({
  "@type": "Organization",
  name: "Vercel",
  url: "https://vercel.com",
});

const webSiteReference = (): JsonLdNode => ({
  "@type": "WebSite",
  name: siteName,
  url: absoluteUrl("/"),
});

/** Site identity for search engines, rendered once on the homepage. */
export const webSiteStructuredData = (description: string): JsonLdNode => ({
  "@context": "https://schema.org",
  ...webSiteReference(),
  description,
  inLanguage: defaultLanguage,
  publisher: publisher(),
});

/** Returns a BreadcrumbList, or undefined when there is no trail beyond the page itself. */
export const breadcrumbListNode = (entries: BreadcrumbEntry[]): JsonLdNode | undefined => {
  // When a folder links to the current page, keep the page's own name.
  const unique = entries.filter((entry, index) => entry.pathname !== entries[index + 1]?.pathname);
  if (unique.length < 2) return;
  return {
    "@type": "BreadcrumbList",
    itemListElement: unique.map((entry, index) => ({
      "@type": "ListItem",
      item: absoluteUrl(entry.pathname),
      name: entry.name,
      position: index + 1,
    })),
  };
};

interface DocsArticleOptions {
  breadcrumbs: BreadcrumbEntry[];
  description?: string;
  image: string;
  lang: string;
  pathname: string;
  title: string;
}

export const docsArticleStructuredData = ({
  breadcrumbs,
  description,
  image,
  lang,
  pathname,
  title,
}: DocsArticleOptions): JsonLdNode => {
  const url = absoluteUrl(pathname);
  const graph: JsonLdNode[] = [
    {
      "@type": "TechArticle",
      headline: title,
      // JSON serialization drops an undefined description.
      description,
      image,
      inLanguage: lang,
      isPartOf: webSiteReference(),
      mainEntityOfPage: url,
      publisher: publisher(),
      url,
    },
  ];
  const breadcrumbList = breadcrumbListNode(breadcrumbs);
  if (breadcrumbList) graph.push(breadcrumbList);
  return { "@context": "https://schema.org", "@graph": graph };
};

export const integrationStructuredData = ({
  name,
  pathname,
}: {
  name: string;
  pathname: string;
}): JsonLdNode => ({
  "@context": "https://schema.org",
  ...breadcrumbListNode([
    { name: "Integrations", pathname: "/integrations" },
    { name, pathname },
  ]),
});

// Geistdocs owns the page-tree version, which can differ from the docs app's Fumadocs version.
interface TreeNode {
  children?: TreeNode[];
  index?: TreeNode;
  name?: unknown;
  type?: string;
  url?: string;
}

const firstPageUrl = (node: TreeNode): string | undefined => {
  if (node.index?.url) return node.index.url;
  for (const child of node.children ?? []) {
    if (child.type === "page" && child.url) return child.url;
    if (child.type === "folder") {
      const url = firstPageUrl(child);
      if (url) return url;
    }
  }
};

const findFolderTrail = (node: TreeNode, url: string): TreeNode[] | undefined => {
  for (const child of node.children ?? []) {
    if (child.type === "page" && child.url === url) return [];
    if (child.type !== "folder") continue;
    if (child.index?.url === url) return [child];
    const trail = findFolderTrail(child, url);
    if (trail) return [child, ...trail];
  }
};

/**
 * Builds the docs breadcrumb trail from the sidebar tree: each enclosing folder,
 * linked to its index or first page, followed by the page itself.
 */
export const docsBreadcrumbs = ({
  pageUrl,
  title,
  tree,
}: {
  pageUrl: string;
  title: string;
  tree: TreeNode;
}): BreadcrumbEntry[] => {
  const folders = findFolderTrail(tree, pageUrl) ?? [];
  const entries = folders.flatMap((folder) => {
    const pathname = firstPageUrl(folder);
    return typeof folder.name === "string" && pathname ? [{ name: folder.name, pathname }] : [];
  });
  return [...entries, { name: title, pathname: pageUrl }];
};
