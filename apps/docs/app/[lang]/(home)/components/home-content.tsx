import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@vercel/geistdocs/components/button";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./architecture";
import { CTA } from "./cta";
import { FeatureGrid } from "./feature-grid";
import { FileTree } from "./file-tree";
import { InstallSwitcher } from "./install-switcher";
import { HeroMetalShader } from "./metal-shader";
import { NextjsInterop } from "./nextjs-interop";

const title = "eve";
const description = "Build durable agents from one folder of Markdown and TypeScript.";

export const homeMetadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    images: [staticOgImage],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [staticOgImage],
  },
};

export const HomeContent = () => (
  <div className="mx-auto w-full max-w-[1080px] pb-32">
    <section className="relative flex min-h-[80vh] flex-col items-center justify-center gap-y-5 px-4 py-24 text-center sm:px-12 sm:py-28">
      <div className="mb-8 aspect-[601/189] w-full max-w-[640px] sm:mb-10 sm:max-w-[760px]">
        <HeroMetalShader />
      </div>
      <h1 className="max-w-5xl text-center font-medium text-heading-36 md:whitespace-nowrap md:text-heading-44 lg:text-heading-56">
        The Framework for Building Agents
      </h1>
      <p className="w-full text-center text-copy-16 text-gray-900 md:max-w-2xl md:text-copy-18 lg:text-copy-20">
        {description}
      </p>
      <div className="mt-2 flex w-full max-w-3xl flex-col items-center gap-4 sm:flex-row sm:items-end sm:justify-center">
        <InstallSwitcher className="items-center" />
        <Button asChild className="h-12 rounded-full bg-gray-1000 px-6 hover:bg-gray-900" size="lg">
          <Link href="/docs/introduction">
            <span className="text-background-100 text-label-16">Read docs</span>
          </Link>
        </Button>
      </div>
    </section>
    <div className="grid">
      <FileTree />
      <ArchitectureDiagram />
      <NextjsInterop />
      <FeatureGrid />
      <CTA />
    </div>
  </div>
);
