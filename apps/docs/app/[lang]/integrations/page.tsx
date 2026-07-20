import type { Metadata } from "next";
import { integrations } from "@/lib/integrations/data";
import { translations } from "@/geistdocs";
import { Gallery } from "./components/gallery";

const title = "Integrations";
const description =
  "Browse the channels, connections, and extensions available to an eve agent, each with install, quick start, and configuration steps.";

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const IntegrationsPage = () => (
  <main className="mx-auto w-full max-w-[1080px] px-4 pb-32 sm:px-6">
    <section className="flex flex-col items-center px-4 pt-24 pb-12 text-center">
      <h1 className="font-bold text-5xl text-gray-1000 tracking-tighter sm:text-6xl">
        Integrations
      </h1>
      <p className="mt-5 max-w-2xl text-gray-900 text-lg">
        Add the channels where people reach your agent, connections to external services, and
        extensions that package reusable capabilities.
      </p>
    </section>
    <Gallery integrations={integrations} />
  </main>
);

export default IntegrationsPage;
