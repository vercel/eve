import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  buildConnectionConfigure,
  buildConnectionInstall,
  buildConnectionSetup,
} from "@/lib/integrations/connection-setup";
import {
  getIntegration,
  integrations,
  protocolBadgeClassName,
  protocolLabel,
} from "@/lib/integrations/data";
import { logos } from "@/lib/integrations/logos";
import { translations } from "@/geistdocs";
import { Markdown } from "../components/markdown";
import { SetupTabs } from "../components/setup-tabs";

const typeLabel = {
  channel: "Channel",
  connection: "Connection",
} as const;

const languages = Object.keys(translations);

export const generateStaticParams = () =>
  languages.flatMap((lang) =>
    integrations.map((integration) => ({ lang, slug: integration.slug })),
  );

export const generateMetadata = async ({
  params,
}: PageProps<"/[lang]/integrations/[slug]">): Promise<Metadata> => {
  const { slug } = await params;
  const integration = getIntegration(slug);
  if (!integration) {
    return {};
  }
  return {
    title: `${integration.name} Integration`,
    description: integration.tagline,
  };
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2 border-t py-8 first:border-t-0 first:pt-0">
    <h2 className="font-semibold text-gray-1000 text-xl tracking-tight">{title}</h2>
    {children}
  </section>
);

const IntegrationDetailPage = async ({ params }: PageProps<"/[lang]/integrations/[slug]">) => {
  const { slug } = await params;
  const integration = getIntegration(slug);

  if (!integration) {
    notFound();
  }

  const Logo = logos[integration.logo];

  const isConnection = Boolean(integration.connection);
  const install = isConnection ? buildConnectionInstall(integration) : (integration.install ?? "");
  const configure = isConnection
    ? buildConnectionConfigure(integration)
    : (integration.configure ?? "");
  const setup = isConnection ? buildConnectionSetup(integration) : null;

  return (
    <main className="mx-auto w-full max-w-[768px] px-4 pt-16 pb-32 sm:px-6">
      <Link
        className="inline-flex items-center gap-1.5 text-gray-800 text-sm transition-colors hover:text-gray-1000"
        href="/integrations"
      >
        <ArrowLeftIcon className="size-3.5" />
        All integrations
      </Link>

      <header className="mt-8 flex flex-col gap-5 border-b pb-10">
        <span className="flex size-14 items-center justify-center rounded-xl border bg-background text-gray-1000">
          <Logo aria-hidden className="size-7" height={28} width={28} />
        </span>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <h1 className="font-bold text-4xl text-gray-1000 tracking-tighter">
              {integration.name}
            </h1>
            <span className="rounded-full border px-2.5 py-0.5 text-gray-900 text-xs">
              {typeLabel[integration.type]}
            </span>
            {integration.protocols?.map((protocol) => (
              <span
                className={`rounded-full px-2 py-0.5 font-medium text-xs ${protocolBadgeClassName[protocol]}`}
                key={protocol}
              >
                {protocolLabel[protocol]}
              </span>
            ))}
          </div>
          <p className="text-gray-900 text-lg">{integration.tagline}</p>
        </div>
        <Link
          className="inline-flex w-fit items-center gap-1 text-gray-900 text-sm transition-colors hover:text-gray-1000"
          href={integration.docsHref}
        >
          Read the full {typeLabel[integration.type].toLowerCase()} docs
          <ArrowUpRightIcon className="size-3.5" />
        </Link>
      </header>

      <div className="mt-10 flex flex-col">
        <Section title="Install">
          <Markdown>{install}</Markdown>
        </Section>
        <Section title="Quick start">
          {setup ? (
            <Suspense
              fallback={
                <Markdown>
                  {setup.variants[`${setup.protocols[0]}:${setup.authModes[0]}`] ?? ""}
                </Markdown>
              }
            >
              <SetupTabs
                authModes={setup.authModes}
                protocols={setup.protocols}
                variants={setup.variants}
              />
            </Suspense>
          ) : (
            <Markdown>{integration.quickStart ?? ""}</Markdown>
          )}
        </Section>
        <Section title="Configure">
          <Markdown>{configure}</Markdown>
        </Section>
      </div>
    </main>
  );
};

export default IntegrationDetailPage;
