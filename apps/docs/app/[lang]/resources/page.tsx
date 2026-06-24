import type { Metadata } from "next";
import Link from "next/link";
import { translations } from "@/geistdocs";
import { type Resource, resources, type ResourceKind } from "@/lib/resources/data";

const title = "Resources";
const description = "Guides, templates, and examples to help you build with eve.";

const kindClassName: Record<ResourceKind, string> = {
  Community: "border-transparent bg-gray-300 text-gray-1000",
  Example: "border-transparent bg-gray-300 text-gray-1000",
  Guide: "border-transparent bg-gray-300 text-gray-1000",
  Reference: "border-transparent bg-gray-300 text-gray-1000",
  Template: "border-transparent bg-gray-300 text-gray-1000",
};

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const ResourceCard = ({ resource }: { resource: Resource }) => {
  const isExternal = resource.href.startsWith("https://");
  const className =
    "flex h-full flex-col gap-3 rounded-xl border border-gray-alpha-400 bg-background-100 p-6 no-underline shadow-none transition-colors hover:bg-gray-100 dark:bg-gray-100 dark:hover:bg-gray-200";
  const content = (
    <>
      <span
        className={`inline-flex w-fit shrink-0 items-center justify-center rounded-full border px-2 py-0.5 font-medium text-xs ${kindClassName[resource.kind]}`}
      >
        {resource.kind}
      </span>
      <h2 className="line-clamp-2 text-balance font-medium text-base text-gray-1000 leading-snug">
        {resource.title}
      </h2>
      <p className="line-clamp-2 text-gray-900 text-sm">{resource.description}</p>
    </>
  );

  if (isExternal) {
    return (
      <a className={className} href={resource.href} rel="noopener noreferrer" target="_blank">
        {content}
      </a>
    );
  }

  return (
    <Link className={className} href={resource.href}>
      {content}
    </Link>
  );
};

const ResourcesPage = () => (
  <main className="mx-auto w-full max-w-5xl px-4 pt-16 pb-16 sm:pt-24">
    <header className="space-y-4 pb-8">
      <h1 className="text-balance font-semibold text-[40px] text-gray-1000 leading-[1.1] tracking-tight sm:text-5xl">
        {title}
      </h1>
      <p className="max-w-2xl text-gray-900 text-lg leading-relaxed">{description}</p>
    </header>
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {resources.map((resource) => (
        <ResourceCard key={resource.title} resource={resource} />
      ))}
    </div>
  </main>
);

export default ResourcesPage;
