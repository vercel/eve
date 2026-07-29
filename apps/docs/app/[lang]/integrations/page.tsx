import type { Metadata } from "next";
import { integrations } from "@/lib/integrations/data";
import { translations } from "@/geistdocs";
import { Gallery, type GalleryFilter } from "./components/gallery";

const title = "Integrations";
const description =
  "Browse the channels, connections, extensions, and instrumentation providers available to an eve agent, each with install, quick start, and configuration steps.";

export const metadata: Metadata = {
  title,
  description,
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

const IntegrationsPage = async ({ searchParams }: PageProps<"/[lang]/integrations">) => {
  const filterParam = (await searchParams).filter;
  const filter =
    typeof filterParam === "string" && galleryFilters.includes(filterParam as GalleryFilter)
      ? (filterParam as GalleryFilter)
      : "all";

  return (
    <main className="mx-auto w-full min-w-0 max-w-[1080px] px-4 pb-32 sm:px-6">
      <section className="flex min-w-0 flex-col items-center px-0 pt-24 pb-12 text-center sm:px-4">
        <h1 className="font-bold text-5xl text-gray-1000 tracking-tighter sm:text-6xl">
          Integrations
        </h1>
        <p className="mt-5 max-w-2xl text-gray-900 text-lg">
          Add the channels where people reach your agent, connections to external services,
          extensions that package reusable capabilities, and instrumentation providers that receive
          traces.
        </p>
      </section>
      <Gallery filter={filter} integrations={integrations} />
      <section className="mt-12 rounded-lg border border-dashed px-6 py-10 text-center">
        <h2 className="font-medium text-gray-1000 text-xl tracking-tight">
          Don&apos;t see your integration?
        </h2>
        <p className="mt-2 text-gray-800 text-sm">
          Help grow the official registry. Read the{" "}
          <a
            className="font-medium text-gray-1000 underline underline-offset-4"
            href="/install-integrations#contribute-an-official-integration"
          >
            integration contribution guide
          </a>
          .
        </p>
      </section>
    </main>
  );
};

export default IntegrationsPage;
