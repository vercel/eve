"use client";

import { Button } from "@vercel/geistdocs/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@vercel/geistdocs/components/dropdown-menu";
import { Input } from "@vercel/geistdocs/components/input";
import { ChevronDownIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { TemplateCategory, TemplateEntry, TemplateIntegration } from "@/lib/templates/data";
import { integrationIcons } from "./integration-icons";

const ALL = "all" as const;

type FilterValue<T extends string> = typeof ALL | T;

interface TemplateGalleryProps {
  entries: TemplateEntry[];
}

interface FilterSelectProps<T extends string> {
  allLabel: string;
  label: string;
  onChange: (value: FilterValue<T>) => void;
  options: T[];
  value: FilterValue<T>;
}

const FilterSelect = <T extends string>({
  allLabel,
  label,
  onChange,
  options,
  value,
}: FilterSelectProps<T>) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button
        aria-label={label}
        className="h-11 w-full justify-between px-3 md:h-9 md:w-44"
        variant="outline"
      >
        <span className="truncate">{value === ALL ? allLabel : value}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 text-gray-800" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
      <DropdownMenuRadioGroup
        onValueChange={(nextValue) => onChange(nextValue as FilterValue<T>)}
        value={value}
      >
        <FilterOption label={allLabel} value={ALL} />
        {options.map((option) => (
          <FilterOption key={option} label={option} value={option} />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

const FilterOption = ({ label, value }: { label: string; value: string }) => (
  <DropdownMenuRadioItem className="min-h-11 md:min-h-8" value={value}>
    {label}
  </DropdownMenuRadioItem>
);

const TemplateCard = ({ entry }: { entry: TemplateEntry }) => (
  <li>
    <Link
      className="flex min-h-36 flex-col rounded-lg border border-gray-alpha-400 bg-background-100 p-4 no-underline outline-none transition-colors hover:border-gray-alpha-500 hover:bg-gray-alpha-100 focus-visible:border-gray-alpha-600 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 focus-visible:ring-offset-background-100 motion-reduce:transition-none"
      href={`/templates/${entry.slug}`}
    >
      <h2 className="text-[16px] leading-none font-medium text-gray-1000">{entry.title}</h2>
      <p className="mt-2 line-clamp-2 max-w-[90%] text-balance text-[14px] leading-[1.3] text-gray-800">
        {entry.description}
      </p>
      <ul aria-label="Integrations" className="mt-auto flex items-center gap-2 pt-4">
        {entry.integrations.map((integration) => {
          const Icon = integrationIcons[integration];
          return (
            <li
              className="flex size-4 items-center justify-center text-gray-700 grayscale"
              key={integration}
              title={integration}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              <span className="sr-only">{integration}</span>
            </li>
          );
        })}
      </ul>
    </Link>
  </li>
);

export const TemplateGallery = ({ entries }: TemplateGalleryProps) => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<FilterValue<TemplateCategory>>(ALL);
  const [integration, setIntegration] = useState<FilterValue<TemplateIntegration>>(ALL);

  const filterOptions = useMemo(() => {
    const categories = new Set<TemplateCategory>();
    const integrations = new Set<TemplateIntegration>();

    for (const entry of entries) {
      categories.add(entry.category);
      for (const entryIntegration of entry.integrations) {
        integrations.add(entryIntegration);
      }
    }

    return {
      categories: Array.from(categories).sort(),
      integrations: Array.from(integrations).sort(),
    };
  }, [entries]);

  const results = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return entries.filter((entry) => {
      if (category !== ALL && entry.category !== category) {
        return false;
      }
      if (integration !== ALL && !entry.integrations.includes(integration)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      return [entry.title, entry.description, entry.category, ...entry.integrations]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, entries, integration, query]);

  return (
    <section aria-label="Templates" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-gray-800"
          />
          <Input
            aria-label="Search templates"
            className="h-11 pr-4 pl-9 text-copy-14 md:h-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search templates and examples…"
            type="search"
            value={query}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 md:flex md:shrink-0">
          <FilterSelect
            allLabel="All categories"
            label="Filter by category"
            onChange={setCategory}
            options={filterOptions.categories}
            value={category}
          />
          <FilterSelect
            allLabel="All integrations"
            label="Filter by integration"
            onChange={setIntegration}
            options={filterOptions.integrations}
            value={integration}
          />
        </div>
      </div>

      <div aria-live="polite">
        {results.length > 0 ? (
          <ul className="grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {results.map((entry) => (
              <TemplateCard entry={entry} key={entry.title} />
            ))}
          </ul>
        ) : (
          <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-gray-alpha-400 px-6 text-center">
            <p className="text-heading-16 text-gray-1000">No matching entries</p>
            <p className="text-copy-14 text-gray-900">Try a different search or filter.</p>
          </div>
        )}
      </div>
    </section>
  );
};
