import { templateGalleryUrl } from "../templates/links";
import { defaultLanguage } from "./languages";

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
      source: `/${defaultLanguage}/docs${source}${extension}`,
      destination: `/docs${destination}${extension}`,
      permanent: true,
    },
  ]);

export const createRootMarkdownRedirects = (source: string, destination: string): DocsRedirect[] =>
  markdownExtensions.map((extension) => ({
    source: `${source}${extension}`,
    destination: `/docs${destination}${extension}`,
    permanent: true,
  }));

export const createIntegrationRedirects = (source: string, destination: string): DocsRedirect[] =>
  extensions.flatMap((extension) => [
    {
      source: `/integrations/${source}${extension}`,
      destination: `/integrations/${destination}${extension}`,
      permanent: true,
    },
    {
      source: `/${defaultLanguage}/integrations/${source}${extension}`,
      destination: `/integrations/${destination}${extension}`,
      permanent: true,
    },
  ]);

export const docsRedirects: DocsRedirect[] = [
  ...createDocsRedirects("/introduction", "/getting-started"),
  ...createDocsRedirects("/installation", "/getting-started"),
  ...createDocsRedirects("/project-structure", "/concepts/project-structure"),
  ...createDocsRedirects("/getting-started/project-structure", "/concepts/project-structure"),
  ...createDocsRedirects("/channels", "/channels/overview"),
  ...createDocsRedirects("/channels/http", "/channels/eve"),
  ...createDocsRedirects("/reference/http-api", "/channels/eve"),
  ...createDocsRedirects("/project-layout", "/getting-started"),
  ...createDocsRedirects("/reference/project-layout", "/getting-started"),
  ...createDocsRedirects("/dynamic-capabilities", "/guides/dynamic-capabilities"),
  ...createDocsRedirects("/guides/state", "/concepts/state"),
  ...createDocsRedirects("/dynamic-workflows", "/concepts/built-in-tools"),
  ...createDocsRedirects("/guides/dynamic-workflows", "/concepts/built-in-tools"),
  ...createDocsRedirects("/subagents/workflow-tool", "/concepts/built-in-tools"),
  ...createDocsRedirects("/sessions", "/concepts/sessions-runs-and-streaming"),
  ...createDocsRedirects("/agent", "/agent-config"),
  ...createDocsRedirects("/guides/acp", "/protocols/acp"),
  ...createDocsRedirects("/guides/ucp", "/protocols/ucp"),
  ...createDocsRedirects("/guides/deployment", "/guides/deployment/overview"),
  ...createDocsRedirects("/guides/frontend/add-a-web-app", "/guides/frontend/nextjs"),
  ...createDocsRedirects("/deployment", "/guides/deployment/overview"),
  ...createDocsRedirects("/deployment/overview", "/guides/deployment/overview"),
  ...createDocsRedirects("/deployment/vercel", "/guides/deployment/vercel"),
  ...createDocsRedirects("/deployment/self-hosting", "/guides/deployment/self-hosting"),
  ...createDocsRedirects("/self-hosting", "/guides/deployment/self-hosting"),
  ...createDocsRedirects("/guides/instrumentation", "/observability/instrumentation"),
  ...createDocsRedirects("/guides/instrumentation-providers", "/observability/instrumentation"),
  ...createDocsRedirects(
    "/observability/instrumentation-providers",
    "/observability/instrumentation",
  ),
  ...createDocsRedirects("/guides/instrumentation-otel", "/observability/otel"),
  ...createDocsRedirects("/observability/instrumentation-otel", "/observability/otel"),
  ...createDocsRedirects("/evals", "/evals/overview"),
  ...createDocsRedirects("/advanced/evals", "/evals/overview"),
  ...createDocsRedirects("/getting-started/installation", "/getting-started"),
  ...createDocsRedirects("/getting-started/multiple-root-agents", "/concepts/project-structure"),
  ...createDocsRedirects("/multi-agent-projects", "/concepts/project-structure"),
  ...createDocsRedirects("/getting-started/first-agent", "/tutorial/first-agent"),
  ...createDocsRedirects("/guides/evaluate", "/guides/decide"),
  ...createDocsRedirects("/sandbox/microsandbox", "/sandbox"),
  ...createDocsRedirects("/tools/tasks-upgrade", "/tools/tasks"),
  ...createDocsRedirects(
    "/observability/instrumentation-migration",
    "/observability/instrumentation",
  ),
];

export const rootMarkdownRedirects: DocsRedirect[] = [
  ["/getting-started", "/getting-started"],
  ["/install-integrations", "/install-integrations"],
  ["/installation", "/getting-started"],
  ["/project-structure", "/concepts/project-structure"],
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
  ...createIntegrationRedirects("chat-sdk-photon", "photon"),
  ...["", `/${defaultLanguage}`].flatMap((prefix) => [
    ...[
      ["eve-chat-template", "eve-chat-template"],
      ["eve-agent-with-python", "eve-agent-with-python"],
      ["eve-slack-agent", "eve-slack-agent"],
      ["eve-data-analyst-template", "eve-data-analyst"],
      ["eve-contentful-agent-template", "eve-contentful-agent"],
      ["eve-vercel-drives-starter", "eve-vercel-drives-starter"],
      ["eve-memory-agent-template", "eve-memory-agent"],
      ["eve-tanstack-start-template", "eve-tanstack-agent"],
      ["eve-software-factory-template", "eve-software-factory"],
      ["marketing-team-eve-template", "eve-marketing-team"],
      ["openinstinct-eve-template", "openinstinct-eve-agent"],
      ["kody-eve-template", "eve-github-maintainer"],
      ["typefully-eve-template", "eve-typefully-agent"],
      ["eve-sre-agent-template", "eve-incident-response-agent"],
      ["sanity-copilot-eve-template", "eve-sanity-copilot"],
    ].flatMap(([source, destination]) =>
      extensions.map((extension) => ({
        source: `${prefix}/templates/${source}${extension}`,
        destination: `${templateGalleryUrl}/${destination}`,
        permanent: true as const,
      })),
    ),
    ...extensions.map((extension) => ({
      source: `${prefix}/templates${extension}`,
      destination: templateGalleryUrl,
      permanent: true as const,
    })),
    {
      source: `${prefix}/templates/:path+`,
      destination: templateGalleryUrl,
      permanent: true as const,
    },
    {
      source: `${prefix}/resources`,
      destination: templateGalleryUrl,
      permanent: true as const,
    },
  ]),
  {
    source: "/r/extension/arcana.json",
    destination: "/r/memory/arcana.json",
    permanent: true,
  },
  {
    source: "/r/extension/upstash-agentkit.json",
    destination: "/r/memory/upstash-agentkit.json",
    permanent: true,
  },
  {
    source: "/r/extension/hindsight.json",
    destination: "/r/memory/hindsight.json",
    permanent: true,
  },
  { source: "/evals", destination: "/benchmarks", permanent: true },
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

export const defaultLanguageRedirects: DocsRedirect[] = [
  {
    source: `/${defaultLanguage}/docs`,
    destination: "/docs/getting-started",
    permanent: true,
  },
  {
    source: `/${defaultLanguage}/:path*`,
    destination: "/:path*",
    permanent: true,
  },
];
