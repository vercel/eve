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

const docsSeoTitles: Readonly<Record<string, string>> = {
  "/docs/agent-config": "Agent configuration (agent.ts)",
  "/docs/concepts/sessions-runs-and-streaming": "Agent sessions, runs, and streaming",
  "/docs/getting-started": "Get started with eve: durable AI agents in TypeScript",
  "/docs/guides/frontend/overview": "Build an AI agent chat UI with useEveAgent",
  "/docs/reference/project-layout": "agent/ directory reference",
  "/docs/reference/typescript-api": "TypeScript API reference",
  "/docs/tutorial/first-agent": "Build your first agent",
};

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
  const seoTitle = docsSeoTitles[pageUrl];
  if (seoTitle) return seoTitle;
  if (pageTitle !== "Overview") return pageTitle;
  return findSidebarParentTitle(tree, pageUrl) ?? pageTitle;
};
