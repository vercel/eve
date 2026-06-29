import type { Metadata } from "next";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./architecture";
import { CTA } from "./cta";
import { FeatureGrid } from "./feature-grid";
import { FileTree } from "./file-tree";
import { InstallSwitcher } from "./install-switcher";
import { NextjsInterop } from "./nextjs-interop";

const title = "eve";
const tagline = "Like Next.js for web apps, but for agents.";
const description =
  "Markdown for instructions and skills, TypeScript for tools. Durable by default.";

export const homeMetadata: Metadata = {
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

export const HomeContent = () => (
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
    <FileTree />
    <ArchitectureDiagram />
    <NextjsInterop />
    <FeatureGrid />
    <CTA />
  </div>
);
