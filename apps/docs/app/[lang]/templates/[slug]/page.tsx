import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { translations } from "@/geistdocs";
import { canonicalAlternates, templatePath } from "@/lib/geistdocs/canonical";
import { pageTitleMetadata } from "@/lib/geistdocs/metadata-title";
import {
  getTemplateEntry,
  templateEntries,
  type TemplateEntry,
  type TemplateFile,
} from "@/lib/templates/data";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { cn } from "@/lib/utils";
import { integrationIcons } from "../integration-icons";
import { FileViewer, type HighlightedTemplateFile } from "./file-viewer";
import { TemplateActions } from "./template-actions";
import { TemplateReadme } from "./template-readme";

interface PageParams {
  lang: string;
  slug: string;
}

export const generateStaticParams = (): PageParams[] =>
  Object.keys(translations).flatMap((lang) =>
    templateEntries.map((entry) => ({ lang, slug: entry.slug })),
  );

export const dynamicParams = false;

export const generateMetadata = async ({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> => {
  const { slug } = await params;
  const entry = getTemplateEntry(slug);
  if (!entry) return { title: "Template not found" };

  const titleMetadata = pageTitleMetadata(`${entry.title} template - eve`);
  return {
    ...titleMetadata,
    description: entry.description,
    alternates: canonicalAlternates(templatePath(entry.slug)),
    openGraph: titleMetadata.openGraph,
    twitter: { ...titleMetadata.twitter, card: "summary_large_image" },
  };
};

const TemplateDetailPage = async ({ params }: { params: Promise<PageParams> }) => {
  const { slug } = await params;
  const entry = getTemplateEntry(slug);
  if (!entry) {
    notFound();
  }
  const highlightedFiles = await Promise.all(entry.files.map(highlightFile));
  const canonicalUrl = new URL(`/templates/${entry.slug}`, getSiteOrigin()).toString();
  const structuredData = createStructuredData(entry, canonicalUrl);

  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
        id={`template-structured-data-${entry.slug}`}
        type="application/ld+json"
      />
      <main className="mx-auto max-w-[1080px] px-4 pt-10 pb-32 sm:px-6 sm:pt-12">
        <Link
          className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-gray-900 text-label-14 no-underline outline-none transition-colors hover:text-gray-1000 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 motion-reduce:transition-none"
          href="/templates"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
          Templates
        </Link>

        <header className="mt-8 grid gap-4 lg:grid-cols-2 lg:items-start lg:gap-8">
          <div className="min-w-0">
            <h1 className="m-0 text-heading-40 text-gray-1000 sm:text-heading-48">
              {entry.headline}
            </h1>
            <div className="hidden lg:block">
              <IntegrationList entry={entry} />
            </div>
          </div>
          <div className="min-w-0">
            <p className="max-w-[520px] text-copy-16 text-gray-900">{entry.description}</p>
            <div className="mt-6">
              <TemplateActions
                setupPrompt={entry.setupPrompt}
                sourceHref={entry.sourceHref}
                template={entry.slug}
              />
            </div>
            <div className="pt-3 lg:hidden">
              <IntegrationList entry={entry} />
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-10 gap-y-4 border-gray-alpha-400 border-t pt-6 lg:col-span-2">
            <OverviewItem label="Model" value={entry.model} />
            <OverviewItem label="Authored files" value={String(entry.files.length)} />
          </dl>
        </header>

        <section aria-label="Filesystem" className="mt-8">
          <FileViewer files={highlightedFiles} />
        </section>

        <section aria-label="README" className="mt-16 border-gray-alpha-400 border-t pt-12">
          <div className="font-mono text-gray-700 text-label-12 uppercase tracking-wider">
            README
          </div>
          <div className="mt-5 max-w-[760px]">
            <TemplateReadme readme={entry.readme} sourceRevisionHref={entry.sourceRevisionHref} />
          </div>
        </section>
      </main>
    </>
  );
};

const createStructuredData = (entry: TemplateEntry, canonicalUrl: string) => ({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          item: new URL("/templates", getSiteOrigin()).toString(),
          name: "Templates",
          position: 1,
        },
        {
          "@type": "ListItem",
          item: canonicalUrl,
          name: entry.headline,
          position: 2,
        },
      ],
    },
    {
      "@type": "SoftwareSourceCode",
      codeRepository: entry.sourceRevisionHref,
      description: entry.description,
      keywords: ["eve", ...entry.integrations],
      name: entry.headline,
      programmingLanguage: ["TypeScript", "Markdown"],
      runtimePlatform: "eve",
      url: canonicalUrl,
    },
  ],
});

const highlightFile = async (file: TemplateFile): Promise<HighlightedTemplateFile> => ({
  code: await highlight(file.contents, {
    lang: file.language,
    theme: geistShikiTheme,
    components: {
      pre: ({ children, ...props }: ComponentProps<"pre">) => (
        <CodeBlock
          {...props}
          className={cn(
            props.className,
            "overflow-x-hidden! whitespace-pre-wrap break-words rounded-none border-0 bg-transparent p-4 text-copy-13-mono [&>code]:min-w-0! [&>code]:w-full!",
          )}
        >
          {children}
        </CodeBlock>
      ),
    },
  }),
  language: file.language,
  relativePath: file.relativePath,
});

const IntegrationList = ({ entry }: { entry: TemplateEntry }) => (
  <ul
    aria-label="Integrations"
    className="mt-5 grid w-full grid-cols-2 gap-x-4 gap-y-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-2"
  >
    {entry.integrations.map((integration) => {
      const Icon = integrationIcons[integration];
      return (
        <li
          className="inline-flex items-center justify-self-center gap-1.5 text-gray-900 text-label-13 sm:justify-self-auto"
          key={integration}
        >
          <Icon aria-hidden="true" className="size-4 grayscale" />
          {integration}
        </li>
      );
    })}
  </ul>
);

const OverviewItem = ({ label, value }: { label: string; value: string }) => (
  <div className="min-w-0">
    <dt className="text-gray-800 text-label-12">{label}</dt>
    <dd className="mt-1 break-all text-copy-13-mono text-gray-1000">{value}</dd>
  </div>
);

export default TemplateDetailPage;
