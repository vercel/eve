interface DocsRedirect {
  destination: string;
  permanent: true;
  source: string;
}

const extensions = ["", ".md", ".mdx"] as const;
const markdownExtensions = [".md", ".mdx"] as const;

export const createDocsRedirects = (source: string, destination: string): DocsRedirect[] =>
  extensions.flatMap((extension) => [
    {
      source: `/docs${source}${extension}`,
      destination: `/docs${destination}${extension}`,
      permanent: true,
    },
    {
      source: `/:lang/docs${source}${extension}`,
      destination: `/:lang/docs${destination}${extension}`,
      permanent: true,
    },
  ]);

export const createRootMarkdownRedirects = (source: string, destination: string): DocsRedirect[] =>
  markdownExtensions.map((extension) => ({
    source: `${source}${extension}`,
    destination: `/docs${destination}${extension}`,
    permanent: true,
  }));

export const docsRedirects: DocsRedirect[] = [
  ...createDocsRedirects("/introduction", "/getting-started"),
  ...createDocsRedirects("/channels", "/channels/overview"),
  ...createDocsRedirects("/channels/http", "/channels/eve"),
  ...createDocsRedirects("/reference/http-api", "/channels/eve"),
  ...createDocsRedirects("/project-layout", "/reference/project-layout"),
  ...createDocsRedirects("/dynamic-capabilities", "/guides/dynamic-capabilities"),
  ...createDocsRedirects("/dynamic-workflows", "/guides/dynamic-workflows"),
  ...createDocsRedirects("/sessions", "/concepts/sessions-runs-and-streaming"),
  ...createDocsRedirects("/agent", "/agent-config"),
  ...createDocsRedirects("/guides/deployment", "/guides/deployment/overview"),
  ...createDocsRedirects("/deployment", "/guides/deployment/overview"),
  ...createDocsRedirects("/deployment/overview", "/guides/deployment/overview"),
  ...createDocsRedirects("/deployment/vercel", "/guides/deployment/vercel"),
  ...createDocsRedirects("/deployment/self-hosting", "/guides/deployment/self-hosting"),
  ...createDocsRedirects("/self-hosting", "/guides/deployment/self-hosting"),
  ...createDocsRedirects("/evals", "/evals/overview"),
  ...createDocsRedirects("/advanced/evals", "/evals/overview"),
  ...createDocsRedirects("/getting-started/installation", "/installation"),
  ...createDocsRedirects("/getting-started/project-structure", "/project-structure"),
  ...createDocsRedirects("/getting-started/first-agent", "/tutorial/first-agent"),
];

export const rootMarkdownRedirects: DocsRedirect[] = [
  ["/getting-started", "/getting-started"],
  ["/install-integrations", "/install-integrations"],
  ["/installation", "/installation"],
  ["/project-structure", "/project-structure"],
  ["/instructions", "/instructions"],
  ["/tools/overview", "/tools"],
  ["/skills", "/skills"],
  ["/channels/eve", "/channels/eve"],
  ["/channels/overview", "/channels/overview"],
  ["/channels/slack", "/channels/slack"],
  ["/channels/discord", "/channels/discord"],
  ["/channels/teams", "/channels/teams"],
  ["/channels/telegram", "/channels/telegram"],
  ["/channels/twilio", "/channels/twilio"],
  ["/channels/github", "/channels/github"],
  ["/channels/linear", "/channels/linear"],
  ["/channels/chat-sdk", "/channels/chat-sdk"],
].flatMap(([source, destination]) => createRootMarkdownRedirects(source, destination));

export const compatibilityRedirects: DocsRedirect[] = [
  { source: "/feed", destination: "/rss.xml", permanent: true },
  { source: "/feed.xml", destination: "/rss.xml", permanent: true },
  { source: "/guides/hooks", destination: "/docs/guides/hooks", permanent: true },
  {
    source: "/apple-touch-icon-precomposed.png",
    destination: "/apple-touch-icon.png",
    permanent: true,
  },
  {
    source: "/apple-touch-icon-120x120.png",
    destination: "/apple-touch-icon.png",
    permanent: true,
  },
  {
    source: "/apple-touch-icon-120x120-precomposed.png",
    destination: "/apple-touch-icon.png",
    permanent: true,
  },
];
