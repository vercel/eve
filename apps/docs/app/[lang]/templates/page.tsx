import type { Metadata } from "next";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { translations } from "@/geistdocs";
import { templateEntries } from "@/lib/templates/data";
import { TemplateGallery } from "./template-gallery";

const title = "Templates";
const description =
  "Explore agents built on eve. Set one up with a prompt or use its source as a starting point.";
const titleMetadata = pageTitleMetadata(title);

export const metadata: Metadata = {
  ...titleMetadata,
  description,
  alternates: canonicalAlternates(canonicalRoutes.templates),
  openGraph: { ...titleMetadata.openGraph, images: [staticOgImage] },
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
    images: [staticOgImage],
  },
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const TemplatesPage = () => (
  <main className="mx-auto max-w-[1080px] px-4 pb-32 sm:px-6">
    <header className="pt-12 pb-8 sm:pt-16 sm:pb-10">
      <h1 className="text-heading-32 text-gray-1000 sm:text-heading-40">{title}</h1>
      <p className="mt-3 max-w-[460px] text-copy-16 text-gray-900">{description}</p>
    </header>
    <TemplateGallery entries={templateEntries} />
  </main>
);

export default TemplatesPage;
