interface DocsRedirect {
  destination: string;
  permanent: true;
  source: string;
}

const extensions = ["", ".md", ".mdx"] as const;

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

export const docsRedirects: DocsRedirect[] = [
  ...createDocsRedirects("/introduction", "/getting-started"),
  ...createDocsRedirects("/channels", "/channels/overview"),
  ...createDocsRedirects("/channels/http", "/channels/eve"),
  ...createDocsRedirects("/reference/http-api", "/channels/eve"),
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
