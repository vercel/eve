"use client";

import { Analytics } from "@vercel/analytics/next";
import { GeistdocsProvider as PackageProvider } from "@vercel/geistdocs/layout";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { SharedProps } from "fumadocs-ui/components/dialog/search";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { config } from "@/lib/geistdocs/config";

type GeistdocsProviderProps = Omit<ComponentProps<typeof PackageProvider>, "config"> & {
  basePath: string | undefined;
  className?: string;
  lang?: string;
};

const DocsSearchDialog = dynamic(
  () => import("./search").then((module) => module.DocsSearchDialog),
  { ssr: false },
);

const TrackedSearchDialog = (props: SharedProps) => (
  <DocsSearchDialog basePath={config.basePath} {...props} />
);

export const GeistdocsProvider = ({
  basePath: _basePath,
  className: _className,
  lang,
  search,
  ...props
}: GeistdocsProviderProps) => {
  return (
    <>
      <PackageProvider
        config={config}
        lang={lang}
        search={{
          ...search,
          SearchDialog: TrackedSearchDialog,
        }}
        {...props}
      />
      <Analytics />
      <SpeedInsights />
    </>
  );
};
