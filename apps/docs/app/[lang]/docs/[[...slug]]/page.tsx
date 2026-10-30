import { getPublicPath } from "@vercel/geistdocs/config";
import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage, createPageActions } from "@vercel/geistdocs/pages/docs";
import type { MDXComponents } from "mdx/types";
import { ChannelPreviewHeader } from "@/components/geistdocs/channel-preview";
import { EditOnGithubAction } from "@/components/geistdocs/edit-on-github";
import { JsonLd } from "@/components/geistdocs/json-ld";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { canonicalAlternates } from "@/lib/geistdocs/canonical";
import { channelPreviews } from "@/lib/channel-previews/scenes";
import { config } from "@/lib/geistdocs/config";
import { defaultLanguage } from "@/lib/geistdocs/languages";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { docsOgImage } from "@/lib/geistdocs/og";
import { resolveDocsPageTitle } from "@/lib/geistdocs/page-title";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { docsArticleStructuredData, docsBreadcrumbs } from "@/lib/geistdocs/structured-data";
import { getSiteOrigin } from "@/lib/geistdocs/url";

type DocsPageEntry = NonNullable<ReturnType<typeof geistdocsSource.source.getPage>>;

const resolveTitle = (page: DocsPageEntry): string => {
  const title = resolveDocsPageTitle({ pageTitle: page.data.title, pageUrl: page.url });
  if (!title) throw new Error(`Missing title for docs page ${page.url}`);
  return title;
};

const DocsStructuredData = ({ page }: { page: DocsPageEntry }) => {
  const lang = page.locale ?? defaultLanguage;
  const title = resolveTitle(page);
  const pathname = getPublicPath(page.url, config.basePath);
  const data = docsArticleStructuredData({
    breadcrumbs: docsBreadcrumbs({
      pageUrl: pathname,
      title,
      tree: geistdocsSource.source.getPageTree(lang),
    }),
    description: page.data.description,
    image: new URL(docsOgImage(page.slugs), getSiteOrigin()).href,
    lang,
    pathname,
    title,
  });
  return <JsonLd data={data} />;
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
    const titleMetadata = pageTitleMetadata(resolveTitle(page));
    const pathname = getPublicPath(page.url, config.basePath);
    const ogImage = docsOgImage(page.slugs);

    return {
      ...metadata,
      ...titleMetadata,
      metadataBase: new URL(getSiteOrigin()),
      alternates: canonicalAlternates(pathname, metadata.alternates),
      openGraph: {
        ...metadata.openGraph,
        ...titleMetadata.openGraph,
        type: "article",
        url: pathname,
        // Override with the static OG image for now. To restore dynamic per-page
        // OG generation, swap the line below back to:
        // images: geistdocsSource.getPageImage(page).url,
        images: [ogImage],
      },
      twitter: {
        ...metadata.twitter,
        ...titleMetadata.twitter,
        card: "summary_large_image",
        images: [ogImage],
      },
    };
  },
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data, page }) => {
    const channelPreview = channelPreviews[page.slugs.join("/")];
    return (
      <>
        <DocsStructuredData page={page} />
        <MobileDocsBar toc={data.toc} />
        {channelPreview ? <ChannelPreviewHeader preview={channelPreview} /> : null}
      </>
    );
  },
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
