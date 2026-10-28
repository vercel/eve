import type { Metadata } from "next";
import { JsonLd } from "@/components/geistdocs/json-ld";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata, siteTitle } from "@/lib/geistdocs/metadata-title";
import { staticOgImage } from "@/lib/geistdocs/og";
import { webSiteStructuredData } from "@/lib/geistdocs/structured-data";
import { AgentTypes } from "./agent-types";
import { ArchitectureDiagram } from "./architecture";
import { GetStarted } from "./get-started";
import { Hero } from "./hero";
import { HowItWorks } from "./how-it-works";
import { Production } from "./production";
import { WhyEve } from "./why-eve";

const tagline =
  "eve is an open-source agent framework for durable, long-running work. Build, govern, and evolve enterprise-grade agents that can scale.";
const titleMetadata = pageTitleMetadata(siteTitle);

export const homeMetadata: Metadata = {
  ...titleMetadata,
  description: tagline,
  alternates: canonicalAlternates(canonicalRoutes.home),
  openGraph: {
    ...titleMetadata.openGraph,
    description: tagline,
    images: [staticOgImage],
    type: "website",
    url: canonicalRoutes.home,
  },
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
    description: tagline,
    images: [staticOgImage],
  },
};

export const HomeContent = () => (
  <div className="mx-auto w-full max-w-[1152px] px-4 sm:px-6">
    <JsonLd data={webSiteStructuredData(tagline)} />
    <Hero tagline={tagline} />
    <AgentTypes />
    <WhyEve />
    <Production />
    <HowItWorks />
    <ArchitectureDiagram />
    <GetStarted />
  </div>
);
