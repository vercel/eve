"use client";

import { track } from "@vercel/analytics";
import { getPublicPath } from "@vercel/geistdocs/config";
import { useDocsSearch } from "fumadocs-core/search/client";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import { useEffect, useRef } from "react";
import {
  analyticsEvents,
  getCountBucket,
  getQueryLengthBucket,
  normalizeSearchQuery,
} from "@/lib/analytics/events";

export const DocsSearchDialog = ({ basePath, ...props }: SharedProps & { basePath?: string }) => {
  const { locale } = useI18n();
  const { search, setSearch, query } = useDocsSearch({
    type: "fetch",
    locale,
    api: getPublicPath("/api/search", basePath),
  });
  const lastTrackedSearch = useRef("");
  const normalizedQuery = normalizeSearchQuery(search);
  const resultCount = Array.isArray(query.data) ? query.data.length : 0;

  useEffect(() => {
    if (!normalizedQuery) {
      lastTrackedSearch.current = "";
      return;
    }
    if (query.isLoading || query.data === undefined) return;

    const searchKey = `${normalizedQuery}:${resultCount}`;
    if (searchKey === lastTrackedSearch.current) return;

    const timer = setTimeout(() => {
      track(analyticsEvents.docsSearched, {
        query: normalizedQuery,
        query_length: getQueryLengthBucket(normalizedQuery),
        results: getCountBucket(resultCount),
      });
      lastTrackedSearch.current = searchKey;
    }, 500);

    return () => clearTimeout(timer);
  }, [normalizedQuery, query.data, query.isLoading, resultCount]);

  return (
    <SearchDialog
      isLoading={query.isLoading}
      onSearchChange={setSearch}
      onSelect={(item) => {
        if (item.type !== "action") {
          track(analyticsEvents.docsSearchResultOpened, {
            query: normalizedQuery,
            result: item.url,
          });
        }
      }}
      search={search}
      {...props}
    >
      <SearchDialogOverlay className="bg-background-100/80 backdrop-blur-none" />
      <SearchDialogContent className="border-none" data-geistdocs-command-modal>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput />
          <SearchDialogClose />
        </SearchDialogHeader>
        <SearchDialogList items={query.data === "empty" ? null : query.data} />
      </SearchDialogContent>
    </SearchDialog>
  );
};
