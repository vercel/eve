import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { canonicalAlternates, canonicalRoutes } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { integrations } from "@/lib/integrations/data";
import { translations } from "@/geistdocs";
import { Gallery, type GalleryFilter } from "./components/gallery";

const title = "Integrations";
const description =
  "Browse the channels, connections, extensions, memory providers, and instrumentation providers available to an eve agent, each with install, quick start, and configuration steps.";
const titleMetadata = pageTitleMetadata(title);

export const metadata: Metadata = {
  ...titleMetadata,
  description,
  alternates: canonicalAlternates(canonicalRoutes.integrations),
  openGraph: titleMetadata.openGraph,
  twitter: {
    ...titleMetadata.twitter,
    card: "summary_large_image",
  },
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const galleryFilters: GalleryFilter[] = [
  "all",
  "channel",
  "connection",
  "extension",
  "instrumentation",
  "memory",
];

const FilteredGallery = async ({
  searchParams,
}: {
  searchParams: PageProps<"/[lang]/integrations">["searchParams"];
}) => {
  const filterParam = (await searchParams).filter;
  const filter =
    typeof filterParam === "string" && galleryFilters.includes(filterParam as GalleryFilter)
      ? (filterParam as GalleryFilter)
      : "all";

  return <Gallery filter={filter} integrations={integrations} />;
};

const IntegrationsPage = ({ searchParams }: PageProps<"/[lang]/integrations">) => {
  return (
    <main className="mx-auto w-full min-w-0 max-w-[1080px] px-4 pb-32 sm:px-6">
      <section className="flex min-w-0 flex-col items-center px-0 pt-24 pb-12 text-center sm:px-4">
        <h1 className="text-gray-1000 text-heading-48 sm:text-heading-64">Integrations</h1>
        <p className="mt-5 max-w-2xl text-gray-900 text-lg">
          Add the channels where people reach your agent, connections to external services,
          extensions that package reusable capabilities, memory providers that retain context across
          sessions, and instrumentation providers that receive traces.
        </p>
      </section>
      <Suspense fallback={<Gallery filter="all" integrations={integrations} />}>
        <FilteredGallery searchParams={searchParams} />
      </Suspense>
      <section className="mt-12 rounded-lg border border-dashed px-6 py-10 text-center">
        <h2 className="text-gray-1000 text-heading-20">Don&apos;t see your integration?</h2>
        <p className="mt-2 text-gray-800 text-sm">
          <Link
            className="font-medium text-gray-1000 underline underline-offset-4"
            href="/docs/install-integrations#contribute-an-official-integration"
            prefetch={true}
          >
            Contribute to the official registry
          </Link>{" "}
          or{" "}
          <Link
            className="font-medium text-gray-1000 underline underline-offset-4"
            href="/docs/install-integrations#host-your-own-registry"
            prefetch={true}
          >
            host a third-party registry
          </Link>
          .
        </p>
      </section>
    </main>
  );
};

export default IntegrationsPage;
