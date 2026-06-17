import type { Metadata } from "next";
import Link from "next/link";
import { Installer } from "@/components/geistdocs/installer";
import { staticOgImage } from "@/lib/geistdocs/og";
import { ArchitectureDiagram } from "./components/architecture";
import { CTA } from "./components/cta";
import { FeatureGrid } from "./components/feature-grid";
import { FileTree } from "./components/file-tree";

const title = "eve";
const tagline = "Like Next.js for web apps, but for agents.";
const description =
  "Markdown for instructions and skills, TypeScript for tools. Durable by default.";
const betaAgreementHref = "https://vercel.com/docs/release-phases/public-beta-agreement";

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
    <section className="relative flex flex-col items-center px-4 pb-32 pt-32 text-center sm:px-12">
      <Link
        href={betaAgreementHref}
        className="mb-6 rounded-full border border-blue-300 px-3 py-1 font-medium text-blue-700 text-xs transition-colors hover:bg-blue-50"
      >
        Beta
      </Link>
      <h1 className="max-w-3xl text-5xl font-bold text-gray-1000 sm:text-6xl xl:text-7xl">
        The Framework
        <br />
        for Building Agents
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-gray-900">
        {tagline} {description}
      </p>
      <div className="mt-10 flex w-full max-w-2xl flex-col items-center gap-4 sm:flex-row sm:justify-center">
        <Installer command="npx eve@latest init my-agent" />
        <Link
          href="/docs/getting-started"
          className="shrink-0 rounded-md border px-6 py-3 text-sm font-medium text-gray-900 transition-colors hover:bg-gray-100 hover:text-gray-1000"
        >
          Read the Docs
        </Link>
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
