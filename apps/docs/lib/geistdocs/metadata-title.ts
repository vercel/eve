import type { Metadata } from "next";

export const siteTitle = "eve – durable AI agent framework";
export const siteTitleTemplate = "%s – eve";

export const rootTitleMetadata = {
  default: siteTitle,
  template: siteTitleTemplate,
} satisfies NonNullable<Metadata["title"]>;

const standaloneBrandPattern = /(?:^|[^a-z0-9])eve(?=$|[^a-z0-9])/i;

export const formatPageTitle = (title: string): string =>
  standaloneBrandPattern.test(title) ? title : siteTitleTemplate.replace("%s", title);

export const metadataTitle = (title: string): NonNullable<Metadata["title"]> =>
  standaloneBrandPattern.test(title) ? { absolute: title } : title;

export const pageTitleMetadata = (
  title: string,
): {
  openGraph: { title: string };
  title: NonNullable<Metadata["title"]>;
  twitter: { title: string };
} => {
  const resolvedTitle = formatPageTitle(title);
  return {
    title: metadataTitle(title),
    openGraph: { title: resolvedTitle },
    twitter: { title: resolvedTitle },
  };
};
