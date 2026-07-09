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
  type Integration,
  integrations,
  protocolBadgeClassName,
  protocolLabel,
} from "@/lib/integrations/data";
import { integrationMarkdown } from "@/lib/integrations/markdown";
import { translations } from "@/geistdocs";
import { CopyMarkdownButton } from "../components/copy-markdown-button";
import { IntegrationLogo } from "../components/integration-logo";
import { Markdown } from "../components/markdown";
import { SetupTabs } from "../components/setup-tabs";

const typeLabel = {
  channel: "Channel",
  connection: "Connection",
} as const;

const languages = Object.keys(translations);

export const dynamicParams = true;

export const generateStaticParams = () =>
  languages.flatMap((lang) =>
    integrations
      .filter((integration) => integration.source !== "generated")
      .map((integration) => ({ lang, slug: integration.slug })),
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

const SurfaceTable = ({ integration }: { integration: Integration }) => {
  const surfaces = integration.surfaces ?? [];
  if (surfaces.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="bg-background-100 text-gray-900">
          <tr>
            <th className="w-[22%] px-4 py-3 font-medium">Surface</th>
            <th className="w-[38%] px-4 py-3 font-medium">Endpoint</th>
            <th className="w-[26%] px-4 py-3 font-medium">Auth</th>
            <th className="w-[14%] px-4 py-3 font-medium">CLI</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {surfaces.map((surface) => (
            <tr key={surface.protocol}>
              <td className="px-4 py-3 align-top">
                <div className="flex flex-col gap-1">
                  <span
                    className={`w-fit rounded-full px-2 py-0.5 font-medium text-xs ${protocolBadgeClassName[surface.protocol]}`}
                  >
                    {protocolLabel[surface.protocol]}
                  </span>
                  <span className="text-gray-800 text-xs">{surface.basisLabel}</span>
                </div>
              </td>
              <td className="px-4 py-3 align-top">
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-gray-800 text-xs">{surface.endpointLabel}</span>
                  <code className="block truncate rounded bg-background-100 px-2 py-1 text-gray-1000 text-xs">
                    {surface.endpointValue}
                  </code>
                </div>
              </td>
              <td className="px-4 py-3 align-top">
                <div className="flex flex-wrap gap-1">
                  {surface.authLabels.map((label) => (
                    <span
                      className="rounded-full border px-2 py-0.5 text-gray-900 text-xs"
                      key={label}
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-4 py-3 align-top text-gray-900">
                {surface.scaffoldable ? "Yes" : "Docs"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const IntegrationDetailPage = async ({ params }: PageProps<"/[lang]/integrations/[slug]">) => {
  const { slug } = await params;
  const integration = getIntegration(slug);

  if (!integration) {
    notFound();
  }

  const isConnection = Boolean(integration.connection);
  const hasSurfaces = (integration.surfaces?.length ?? 0) > 0;
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
          <IntegrationLogo className="size-7" integration={integration} size={28} />
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
        <div className="flex flex-wrap items-center gap-4">
          <Link
            className="inline-flex w-fit items-center gap-1 text-gray-900 text-sm transition-colors hover:text-gray-1000"
            href={integration.docsHref}
          >
            Read the full {typeLabel[integration.type].toLowerCase()} docs
            <ArrowUpRightIcon className="size-3.5" />
          </Link>
          <CopyMarkdownButton markdown={integrationMarkdown(integration)} />
          <a
            className="inline-flex w-fit items-center gap-1 text-gray-900 text-sm transition-colors hover:text-gray-1000"
            href={`/integrations/${integration.slug}.md`}
          >
            View as Markdown
            <ArrowUpRightIcon className="size-3.5" />
          </a>
        </div>
      </header>

      <div className="mt-10 flex flex-col">
        <Section title="Install">
          <Markdown>{install}</Markdown>
        </Section>
        {hasSurfaces ? (
          <Section title="Surfaces">
            <SurfaceTable integration={integration} />
          </Section>
        ) : null}
        <Section title="Quick start">
          {setup ? (
            <Suspense
              fallback={
                <Markdown>
                  {setup.variants[
                    `${setup.surfaces[0]?.protocol}:${setup.surfaces[0]?.authModes[0]}`
                  ] ?? ""}
                </Markdown>
              }
            >
              <SetupTabs surfaces={setup.surfaces} variants={setup.variants} />
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
