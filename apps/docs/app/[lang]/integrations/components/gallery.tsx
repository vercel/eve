"use client";

import { Input } from "@vercel/geistdocs/components/input";
import { InputGroup, InputGroupAddon } from "@vercel/geistdocs/components/input-group";
import { SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GalleryIntegration } from "@/lib/integrations/data";
import { cn } from "@/lib/utils";
import { IntegrationCard } from "./integration-card";

type Filter = "all" | "channel" | "mcp" | "openapi";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "channel", label: "Channels" },
  { value: "mcp", label: "MCP" },
  { value: "openapi", label: "OpenAPI" },
];

const FILTER_DESCRIPTIONS: Partial<Record<Filter, string>> = {
  channel: "Channels are the places where people talk to an eve agent.",
  mcp: "MCP integrations expose provider tools through a remote MCP server.",
  openapi: "OpenAPI integrations turn provider specs into callable agent tools.",
};

interface GalleryProps {
  integrations: GalleryIntegration[];
}

/** Cards rendered initially and added per scroll increment. */
const PAGE_SIZE = 120;

const isFilter = (value: string | null): value is Filter =>
  FILTERS.some((candidate) => candidate.value === value);

/**
 * Mirrors search and filter state into query params (`?q=…&filter=…`) so the
 * state survives navigating to a detail page and back. `replaceState` keeps
 * typing from flooding the history stack.
 */
const syncUrl = (query: string, filter: Filter) => {
  const url = new URL(window.location.href);
  if (query) url.searchParams.set("q", query);
  else url.searchParams.delete("q");
  if (filter !== "all") url.searchParams.set("filter", filter);
  else url.searchParams.delete("filter");
  window.history.replaceState(null, "", url);
};

export const Gallery = ({ integrations }: GalleryProps) => {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  // URL state is applied after hydration (not via useSearchParams) so the
  // gallery stays in the statically prerendered HTML — a Suspense boundary
  // here would blank the list on every first paint.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initialQuery = params.get("q");
    if (initialQuery) setQuery(initialQuery);
    const initialFilter = params.get("filter");
    if (isFilter(initialFilter)) setFilter(initialFilter);
  }, []);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return integrations.filter((integration) => {
      const surfaces = integration.surfaces ?? [];
      if (
        (filter === "channel" && integration.type !== "channel") ||
        (filter === "mcp" && !surfaces.some((surface) => surface.protocol === "mcp")) ||
        (filter === "openapi" && !surfaces.some((surface) => surface.protocol === "openapi"))
      ) {
        return false;
      }
      if (!normalized) {
        return true;
      }
      const haystack = [
        integration.name,
        integration.tagline,
        ...(integration.keywords ?? []),
        ...surfaces.flatMap((surface) => [
          surface.name,
          surface.endpointValue,
          ...surface.authLabels,
        ]),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [integrations, filter, query]);
  const visibleResults = results.slice(0, visibleCount);

  useEffect(() => {
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((count) => count + PAGE_SIZE);
        }
      },
      { rootMargin: "1600px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <div className="flex w-full min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex w-full flex-wrap gap-1 rounded-md border bg-background-100 p-1 sm:w-fit">
          {FILTERS.map(({ value, label }) => (
            <button
              className={cn(
                "rounded px-3 py-1 font-medium text-sm transition-colors",
                filter === value
                  ? "bg-gray-100 text-gray-1000"
                  : "text-gray-900 hover:bg-gray-100/40 hover:text-gray-1000",
              )}
              key={value}
              onClick={() => {
                setFilter(value);
                setVisibleCount(PAGE_SIZE);
                syncUrl(query, value);
              }}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <InputGroup className="h-9 w-full bg-background sm:w-64">
          <InputGroupAddon>
            <SearchIcon className="size-4 text-gray-700" />
          </InputGroupAddon>
          <Input
            aria-label="Search integrations"
            className="h-full border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            onChange={(event) => {
              setQuery(event.target.value);
              setVisibleCount(PAGE_SIZE);
              syncUrl(event.target.value, filter);
            }}
            placeholder="Search integrations"
            value={query}
          />
        </InputGroup>
      </div>

      {FILTER_DESCRIPTIONS[filter] ? (
        <p className="text-gray-800 text-sm">{FILTER_DESCRIPTIONS[filter]}</p>
      ) : null}

      {results.length > 0 ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleResults.map((integration) => (
            <IntegrationCard integration={integration} key={integration.slug} />
          ))}
          {visibleResults.length < results.length ? (
            <div aria-hidden className="col-span-full h-px" ref={setSentinel} />
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed py-16 text-center">
          <p className="font-medium text-gray-1000">No integrations found</p>
          <p className="text-gray-800 text-sm">Try a different search or filter.</p>
        </div>
      )}
    </div>
  );
};
