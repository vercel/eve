export const getMarkdownRequestedPath = ({ slug }: { slug: string[] }): string =>
  slug[0] === "integrations" ? `/${slug.join("/")}` : ["/docs", ...slug].join("/");
