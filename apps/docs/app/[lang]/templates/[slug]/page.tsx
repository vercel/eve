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
import { getTemplateEntry, type TemplateEntry, type TemplateFile } from "@/lib/templates/data";
import { templateManifest } from "@/lib/templates/manifest";
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
    templateManifest.map((entry) => ({ lang, slug: entry.slug })),
  );

export const dynamicParams = false;

export const generateMetadata = async ({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> => {
  const { slug } = await params;
  const entry = templateManifest.find((template) => template.slug === slug);
  if (!entry) {
    return { title: "Template not found" };
  }

  const canonicalPath = templatePath(entry.slug);
  const titleMetadata = pageTitleMetadata(`${entry.title} template`);
  return {
    ...titleMetadata,
    description: entry.description,
    alternates: canonicalAlternates(canonicalPath),
    openGraph: {
      ...titleMetadata.openGraph,
      description: entry.description,
      type: "website",
      url: canonicalPath,
    },
    twitter: {
      ...titleMetadata.twitter,
      card: "summary_large_image",
      description: entry.description,
    },
  };
};

const TemplateDetailPage = async ({ params }: { params: Promise<PageParams> }) => {
  const { slug } = await params;
  const entry = await getTemplateEntry(slug);
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
            <h1 className="m-0 text-heading-40 text-gray-1000 sm:text-heading-48">{entry.title}</h1>
            <div className="hidden lg:block">
              <IntegrationList entry={entry} />
            </div>
          </div>
          <div className="min-w-0">
            <p className="max-w-[520px] text-copy-16 text-gray-900">{entry.description}</p>
            <div className="mt-6">
              <TemplateActions
                demoHref={entry.demoHref}
                setupPrompt={entry.setupPrompt}
                sourceHref={entry.sourceHref}
                template={entry.slug}
              />
            </div>
            <div className="pt-3 lg:hidden">
              <IntegrationList entry={entry} />
            </div>
          </div>
        </header>

        <section aria-label="Filesystem" className="mt-8">
          <FileViewer files={highlightedFiles} />
        </section>

        <section
          aria-label="Template documentation"
          className="mt-16 grid gap-10 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12"
        >
          <div>
            <TemplateReadme readme={entry.readme} sourceRevisionHref={entry.sourceRevisionHref} />
          </div>
          <aside className="order-first lg:order-none" aria-labelledby="github-heading">
            <h2 className="m-0 text-heading-24 text-gray-1000" id="github-heading">
              GitHub
            </h2>
            <dl className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-1">
              <div>
                <dt className="font-medium text-gray-1000 text-label-14">Owner</dt>
                <dd className="mt-2 text-copy-14">
                  <a
                    className="rounded-sm font-medium text-gray-900 underline decoration-gray-400 underline-offset-4 outline-none transition-colors hover:text-gray-1000 hover:decoration-gray-1000 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 motion-reduce:transition-none"
                    href={`https://github.com/${entry.githubOwner}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {entry.githubOwner}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="font-medium text-gray-1000 text-label-14">Repository</dt>
                <dd className="mt-2 text-copy-14">
                  <a
                    className="break-words rounded-sm font-medium text-gray-900 underline decoration-gray-400 underline-offset-4 outline-none transition-colors hover:text-gray-1000 hover:decoration-gray-1000 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 motion-reduce:transition-none"
                    href={`https://github.com/${entry.githubOwner}/${entry.githubRepo}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {entry.githubRepo}
                  </a>
                </dd>
              </div>
            </dl>
          </aside>
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
          name: entry.title,
          position: 2,
        },
      ],
    },
    {
      "@type": "SoftwareSourceCode",
      codeRepository: entry.sourceRevisionHref,
      description: entry.description,
      keywords: ["eve", ...entry.integrations],
      name: entry.title,
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

export default TemplateDetailPage;
