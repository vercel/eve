import { canonicalPathname } from "./canonical";

export interface SitemapSourceEntry {
  lastModified?: Date;
  pathname: string;
}

export interface CanonicalSitemapEntry {
  lastModified?: Date;
  url: string;
}

interface CreateCanonicalSitemapOptions {
  excludedPathnames?: Iterable<string>;
  origin: string;
  sources: SitemapSourceEntry[];
}

const alternateRepresentationPattern = /\.(?:md|mdx|txt|xml)$/i;

const isIndexableHtmlPath = (pathname: string): boolean =>
  pathname === "/" ||
  pathname === "/integrations" ||
  pathname === "/templates" ||
  /^\/docs\/.+/.test(pathname) ||
  /^\/integrations\/[^/]+$/.test(pathname) ||
  /^\/templates\/[^/]+$/.test(pathname);

const trustedLastModified = (value: Date | undefined): Date | undefined =>
  value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;

export const createCanonicalSitemap = ({
  excludedPathnames = [],
  origin,
  sources,
}: CreateCanonicalSitemapOptions): CanonicalSitemapEntry[] => {
  const excluded = new Set(Array.from(excludedPathnames, canonicalPathname));
  const entries = new Map<string, CanonicalSitemapEntry>();

  for (const source of sources) {
    const pathname = canonicalPathname(source.pathname);
    if (pathname !== source.pathname) continue;
    if (!isIndexableHtmlPath(pathname)) continue;
    if (alternateRepresentationPattern.test(pathname)) continue;
    if (excluded.has(pathname)) continue;

    const url = new URL(pathname, `${origin.replace(/\/$/, "")}/`).toString();
    if (entries.has(url)) continue;

    const lastModified = trustedLastModified(source.lastModified);
    entries.set(url, lastModified ? { url, lastModified } : { url });
  }

  return Array.from(entries.values()).sort((a, b) => a.url.localeCompare(b.url));
};
