import type { Metadata } from "next";
import { translations } from "@/geistdocs";
import { templateEntries } from "@/lib/templates/data";
import { TemplateGallery } from "./template-gallery";

const title = "Templates";
const description =
  "Explore agents built on eve. Set one up with a prompt or use its source as a starting point.";

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const TemplatesPage = () => (
  <main className="mx-auto max-w-[1080px] px-4 pb-32 sm:px-6">
    <header className="pt-12 pb-8 sm:pt-16 sm:pb-10">
      <h1 className="font-medium! text-heading-32 text-gray-1000 tracking-tighter sm:text-heading-40">
        {title}
      </h1>
      <p className="mt-3 max-w-[460px] text-copy-16 text-gray-900">{description}</p>
    </header>
    <TemplateGallery entries={templateEntries} />
  </main>
);

export default TemplatesPage;
