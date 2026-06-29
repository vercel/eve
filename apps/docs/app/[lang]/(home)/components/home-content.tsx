import type { Metadata } from "next";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./architecture";
import { CTA } from "./cta";
import { FeatureGrid } from "./feature-grid";
import { FileTree } from "./file-tree";
import { InstallSwitcher } from "./install-switcher";
import { HeroMetalShader } from "./metal-shader";
import { NextjsInterop } from "./nextjs-interop";

const title = "eve";
const tagline = "Like Next.js for agents. Build durable agents with one folder.";

export const homeMetadata: Metadata = {
  title,
  description: tagline,
  openGraph: {
    title,
    description: tagline,
    images: [staticOgImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description: tagline,
    images: [staticOgImage],
  },
};

export const HomeContent = () => (
  <div className="mx-auto w-full max-w-[1080px] pb-32">
    <section className="relative flex min-h-[80vh] flex-col items-center justify-center gap-y-5 px-4 py-24 text-center sm:px-12 sm:py-28">
      <div className="mb-8 aspect-[601/189] w-full max-w-[820px] sm:mb-10 sm:max-w-[900px]">
        <HeroMetalShader />
      </div>
      <h1 className="max-w-5xl text-center font-normal! text-heading-40 md:whitespace-nowrap md:text-heading-48 lg:text-heading-56">
        The Framework for Building Agents
      </h1>
      <p className="w-full text-center text-copy-16 text-gray-900 md:max-w-2xl md:text-copy-18 lg:text-copy-20">
        {tagline}
      </p>
      <InstallSwitcher className="items-center mt-2" />
    </section>
    <FileTree />
    <NextjsInterop />
    <ArchitectureDiagram />
    <FeatureGrid />
    <CTA />
  </div>
);
