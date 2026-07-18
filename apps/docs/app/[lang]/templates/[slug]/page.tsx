import { CodeBlock } from "@vercel/geistdocs/components/code-block";
import { geistShikiTheme } from "@vercel/geistdocs/shiki-theme";
import { highlight } from "fumadocs-core/highlight";
import { ArrowLeftIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import { translations } from "@/geistdocs";
import {
  getTemplateEntry,
  templateEntries,
  type TemplateEntry,
  type TemplateFile,
} from "@/lib/templates/data";
import { cn } from "@/lib/utils";
import { integrationIcons } from "../integration-icons";
import { FileViewer, type HighlightedTemplateFile } from "./file-viewer";
import { TemplateActions } from "./template-actions";

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
  return entry
    ? { title: entry.title, description: entry.description }
    : { title: "Template not found" };
};

const TemplateDetailPage = async ({ params }: { params: Promise<PageParams> }) => {
  const { slug } = await params;
  const entry = getTemplateEntry(slug);
  if (!entry) {
    notFound();
  }
  const highlightedFiles = await Promise.all(entry.files.map(highlightFile));

  return (
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
          <h1 className="m-0 font-medium! text-heading-40 text-gray-1000 tracking-tighter sm:text-heading-48">
            {entry.title}
          </h1>
          <div className="hidden lg:block">
            <IntegrationList entry={entry} />
          </div>
        </div>
        <div className="min-w-0">
          <p className="max-w-[520px] text-copy-16 text-gray-900">{entry.description}</p>
          <div className="mt-6">
            <TemplateActions setupPrompt={entry.setupPrompt} sourceHref={entry.sourceHref} />
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

      <section className="mt-14">
        <div>
          <h2 className="text-heading-24 text-gray-1000">Filesystem</h2>
          <p className="mt-2 text-copy-14 text-gray-900">
            Browse the authored files at revision{" "}
            <code className="text-copy-13-mono">{entry.sourceRevision.slice(0, 7)}</code>.
          </p>
        </div>
        <div className="mt-4">
          <FileViewer files={highlightedFiles} />
        </div>
      </section>
    </main>
  );
};

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
