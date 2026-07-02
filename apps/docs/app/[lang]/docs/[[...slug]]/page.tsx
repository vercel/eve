import { MobileDocsBar } from "@vercel/geistdocs/mobile-docs-bar";
import { createDocsPage, createPageActions } from "@vercel/geistdocs/pages/docs";
import type { MDXComponents } from "mdx/types";
import { EditOnGithubAction } from "@/components/geistdocs/edit-on-github";
import { getMDXComponents } from "@/components/geistdocs/mdx-components";
import { config } from "@/lib/geistdocs/config";
import { staticOgImage } from "@/lib/geistdocs/og";
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
  metadata: ({ metadata }) => ({
    ...metadata,
    metadataBase: new URL(getSiteOrigin()),
    openGraph: {
      ...metadata.openGraph,
      // Override with the static OG image for now. To restore dynamic per-page
      // OG generation, add `page` back to the destructure above and swap the
      // line below back to: images: geistdocsSource.getPageImage(page).url,
      images: [staticOgImage],
    },
  }),
  source: geistdocsSource,
  tableOfContentPopover: {
    enabled: false,
  },
  renderTop: ({ data }) => <MobileDocsBar toc={data.toc} />,
});

export default docsPage.Page;
export const generateStaticParams = docsPage.generateStaticParams;
export const generateMetadata = docsPage.generateMetadata;
