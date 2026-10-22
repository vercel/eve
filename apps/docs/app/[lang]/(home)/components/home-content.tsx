import type { Metadata } from "next";
import { JsonLd } from "@/components/geistdocs/json-ld";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata, siteTitle } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { webSiteStructuredData } from "@/lib/geistdocs/structured-data";
import { AgentTrace } from "./agent-trace";
import { ArchitectureDiagram } from "./architecture";
import { BuiltWithEve } from "./built-with-eve";
import { CTA } from "./cta";
import { FileTree } from "./file-tree";
import { HeroAudience } from "./hero-audience";
import { Programmable } from "./programmable";
import { WhereEveFits } from "./where-eve-fits";

const headline = "The framework for production agents";
const subhead =
  "eve runs the agent loop and everything around it: channels, schedules, approvals, sandboxes, durable sessions, and evals. Write it in TypeScript and deploy it to Vercel or your own infrastructure.";
const description =
  "The TypeScript framework for production AI agents, with durable sessions, channels, approvals, sandboxes, and evals built in. Deploy to Vercel or your own infrastructure.";
const titleMetadata = pageTitleMetadata(siteTitle);

export const homeMetadata: Metadata = {
  ...titleMetadata,
  description,
  alternates: canonicalAlternates(canonicalRoutes.home),
  openGraph: {
    ...titleMetadata.openGraph,
    description,
    images: [staticOgImage],
    type: "website",
    url: canonicalRoutes.home,
  },
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
    description,
    images: [staticOgImage],
  },
};

export const HomeContent = () => (
  <div className="mx-auto w-full max-w-[1080px] pb-8">
    <JsonLd data={webSiteStructuredData(description)} />
    <section className="relative isolate flex min-h-[80vh] flex-col items-center justify-center gap-y-5 px-4 pt-24 pb-12 text-center sm:px-12 sm:pb-16 sm:pt-42">
      <HeroAudience headline={headline} subhead={subhead} />
    </section>
    <AgentTrace />
    <FileTree />
    <Programmable />
    <BuiltWithEve />
    <WhereEveFits />
    <ArchitectureDiagram />
    <CTA />
  </div>
);
