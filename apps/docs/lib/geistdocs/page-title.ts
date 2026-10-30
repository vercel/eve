interface ResolveDocsPageTitleOptions {
  pageTitle?: string;
  pageUrl: string;
}

const docsSeoTitles: Readonly<Record<string, string>> = {
  "/docs/agent-config": "Agent configuration (agent.ts)",
  "/docs/concepts/sessions-runs-and-streaming": "Agent sessions, runs, and streaming",
  "/docs/getting-started": "Get started with eve: durable AI agents in TypeScript",
  "/docs/guides/frontend": "Build an AI agent chat UI with useEveAgent",
  "/docs/reference/typescript-api": "TypeScript API reference",
  "/docs/tutorial/first-agent": "Build your first agent",
};

export const resolveDocsPageTitle = ({
  pageTitle,
  pageUrl,
}: ResolveDocsPageTitleOptions): string | undefined => docsSeoTitles[pageUrl] ?? pageTitle;
