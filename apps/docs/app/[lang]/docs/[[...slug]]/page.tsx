import { getPublicPath } from "@vercel/geistdocs/config";
import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage, createPageActions } from "@vercel/geistdocs/pages/docs";
import type { MDXComponents } from "mdx/types";
import { EditOnGithubAction } from "@/components/geistdocs/edit-on-github";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { canonicalAlternates } from "@/lib/geistdocs/canonical";
import { config } from "@/lib/geistdocs/config";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { resolveDocsPageTitle } from "@/lib/geistdocs/page-title";
import { geistdocsSource } from "@/lib/geistdocs/source";
import { getSiteOrigin } from "@/lib/geistdocs/url";

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
    const title = resolveDocsPageTitle({
      pageTitle: page.data.title,
      pageUrl: page.url,
      tree: geistdocsSource.source.getPageTree(params.lang),
    });
    if (!title) throw new Error(`Missing title for docs page ${page.url}`);
    const titleMetadata = pageTitleMetadata(title);

    return {
      ...metadata,
      ...titleMetadata,
      metadataBase: new URL(getSiteOrigin()),
      alternates: canonicalAlternates(
        getPublicPath(page.url, config.basePath),
        metadata.alternates,
      ),
      openGraph: {
        ...metadata.openGraph,
        ...titleMetadata.openGraph,
        // Override with the static OG image for now. To restore dynamic per-page
        // OG generation, swap the line below back to:
        // images: geistdocsSource.getPageImage(page).url,
        images: [staticOgImage],
      },
      twitter: {
        ...metadata.twitter,
        ...titleMetadata.twitter,
        card: "summary_large_image",
        images: [staticOgImage],
      },
    };
  },
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
