// Geistdocs owns the page-tree version, which can differ from the docs app's Fumadocs version.
interface SidebarNode {
  children?: SidebarNode[];
  fallback?: SidebarNode;
  index?: SidebarNode;
  name?: unknown;
  type?: string;
  url?: string;
}

interface ResolveDocsPageTitleOptions {
  pageTitle?: string;
  pageUrl: string;
  tree: SidebarNode;
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

export const resolveDocsPageTitle = ({
  pageTitle,
  pageUrl,
  tree,
}: ResolveDocsPageTitleOptions): string | undefined => {
  if (pageTitle !== "Overview") return pageTitle;
  return findSidebarParentTitle(tree, pageUrl) ?? pageTitle;
};
