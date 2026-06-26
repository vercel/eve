import type { Metadata } from "next";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./components/architecture";
import { CTA } from "./components/cta";
import { FeatureGrid } from "./components/feature-grid";
import { FileTree } from "./components/file-tree";
import { InstallSwitcher } from "./components/install-switcher";

const title = "eve";
const tagline = "Like Next.js for web apps, but for agents.";
const description =
  "Markdown for instructions and skills, TypeScript for tools. Durable by default.";

export const metadata: Metadata = {
  title,
  description: `${tagline} ${description}`,
  openGraph: {
    title,
    description: `${tagline} ${description}`,
    images: [staticOgImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: `${tagline} ${description}`,
    images: [staticOgImage],
  },
};

const HomePage = () => (
  <div className="mx-auto w-full max-w-[1080px] pb-32">
    <section className="relative flex flex-col items-center gap-y-5 px-4 pb-32 pt-32 text-center sm:px-12">
      <h1 className="max-w-5xl text-center text-heading-40 md:text-heading-48 lg:text-heading-64">
        The Framework
        <br />
        for Building Agents
      </h1>
      <p className="w-full text-center text-copy-16 text-gray-900 md:max-w-2xl md:text-copy-18 lg:text-copy-20">
        {tagline} {description}
      </p>
      <div className="mt-2 flex w-full max-w-2xl flex-col items-center gap-4">
        <InstallSwitcher className="items-center" />
      </div>
    </section>
    <div className="grid divide-y border-y sm:border-x">
      <FileTree />
      <ArchitectureDiagram />
      <FeatureGrid />
      <CTA />
    </div>
  </div>
);

export default HomePage;
