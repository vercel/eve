import type { Metadata } from "next";

export const canonicalRoutes = {
  home: "/",
  integrations: "/integrations",
  templates: "/templates",
} as const;

export const integrationPath = (slug: string): string => `${canonicalRoutes.integrations}/${slug}`;

export const templatePath = (slug: string): string => `${canonicalRoutes.templates}/${slug}`;

export const canonicalPathname = (value: string): string => {
  const pathname = value.split(/[?#]/, 1)[0] || canonicalRoutes.home;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) {
    throw new Error(`Canonical path must be site-relative: ${value}`);
  }
  return pathname;
};

export const canonicalAlternates = (
  pathname: string,
  alternates?: Metadata["alternates"],
): NonNullable<Metadata["alternates"]> => ({
  ...alternates,
  canonical: canonicalPathname(pathname),
});
