import type { Metadata } from "next";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./architecture";
import { CTA } from "./cta";
import { FeatureGrid } from "./feature-grid";
import { FileTree } from "./file-tree";
import { HeroAudience } from "./hero-audience";
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
    <section className="relative isolate flex min-h-[80vh] flex-col items-center justify-center gap-y-5 px-4 pt-24 pb-12 text-center sm:px-12 sm:pb-16 sm:pt-42">
      <HeroAudience tagline={tagline} />
    </section>
    <FileTree />
    <NextjsInterop />
    <ArchitectureDiagram />
    <FeatureGrid />
    <CTA />
  </div>
);
