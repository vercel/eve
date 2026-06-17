import type { Metadata } from "next";
import { integrations } from "@/lib/integrations/data";
import { translations } from "@/geistdocs";
import { Gallery } from "./components/gallery";

const title = "Integrations";
const description =
  "Browse every third-party service eve connects to: messaging channels and MCP connections, each with install, quick start, and configuration steps.";

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
        Connect eve to the services your agent needs, including messaging channels and tool
        connections over MCP or OpenAPI.
      </p>
    </section>
    <Gallery integrations={integrations} />
  </main>
);

export default IntegrationsPage;
