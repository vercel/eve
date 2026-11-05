"use client";

import { IconChevronRightSmall } from "@vercel/geistdocs/assets/icons";
import { Badge } from "@vercel/geistdocs/components/badge";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";
import { PrefetchLink } from "./section";

/** What a dynamic file gives each plan, or null where the plan doesn't get it. */
export interface PlanResults {
  enterprise: string;
  pro: string | null;
}

interface FileTreeItem {
  /** File or folder name shown in the file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  /** Pre-highlighted code, rendered on the server through the geistdocs CodeBlock. */
  code: ReactNode;
  /** Set on dynamic files only. */
  results?: PlanResults;
}

// The customers the same agent can be helping, with the dashboard's plan badge colors. The
// switch shows how one agent behaves per customer, not separate versions of it.
const CUSTOMERS = [
  { id: "enterprise", name: "Acme Org", plan: "Enterprise", badge: "purple" },
  { id: "pro", name: "Jamie", plan: "Pro", badge: "blue" },
] as const;

type Customer = (typeof CUSTOMERS)[number];

function PlanBadge({ customer }: { customer: Customer }) {
  return (
    <Badge className="h-5 px-2" contrast="low" size="sm" variant={customer.badge}>
      {customer.plan}
    </Badge>
  );
}

/** The selected customer's branch is highlighted like a Geist highlighted line; the other dims. */
const branchHighlight = cn(
  "data-[customer=enterprise]:[&_.line[data-plan=enterprise]]:bg-purple-100 data-[customer=enterprise]:[&_.line[data-plan=enterprise]]:shadow-[inset_2px_0_0_0_var(--ds-purple-800)] data-[customer=enterprise]:[&_.line[data-plan=pro]]:opacity-40",
  "data-[customer=pro]:[&_.line[data-plan=pro]]:bg-blue-100 data-[customer=pro]:[&_.line[data-plan=pro]]:shadow-[inset_2px_0_0_0_var(--ds-blue-800)] data-[customer=pro]:[&_.line[data-plan=enterprise]]:opacity-40",
);

/** Under the description: what this customer gets from the file, or that it's the same for all. */
function Resolution({ item, customer }: { item: FileTreeItem; customer: Customer }) {
  if (!item.results) {
    return (
      <p className="border-b px-4 py-3 text-copy-14 text-gray-700">
        Static in this example. Any file can be dynamic.
      </p>
    );
  }
  const result = item.results[customer.id];
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 text-copy-14">
      <span className="font-medium text-gray-1000">{customer.name}</span>
      <PlanBadge customer={customer} />
      <span className={result ? "text-gray-900" : "text-gray-700"}>
        {result ?? `Not on ${customer.plan}`}
      </span>
    </div>
  );
}

/**
 * The tag beside a file in the tree: dynamic files say so (or that the customer doesn't get
 * them), and static ones past the required instructions.md are optional, in a lighter gray.
 */
function Tag({
  item,
  customer,
  active,
  required,
}: {
  item: FileTreeItem;
  customer: Customer;
  active: boolean;
  required: boolean;
}) {
  if (!item.results) {
    if (required) return null;
    return (
      <span
        className={cn(
          "ml-auto shrink-0 font-mono text-label-12-mono!",
          active ? "text-gray-700" : "text-gray-500",
        )}
      >
        optional
      </span>
    );
  }
  const missing = item.results[customer.id] === null;
  return (
    <span
      className={cn(
        "ml-auto shrink-0 font-mono text-label-12-mono!",
        active ? "text-gray-1000" : "text-gray-900",
      )}
    >
      {missing ? `not on ${customer.plan}` : "dynamic"}
    </span>
  );
}

export function FileTreeView({ items }: { items: FileTreeItem[] }) {
  const [customer, setCustomer] = useState<Customer>(CUSTOMERS[0]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selected = items[selectedIndex];

  const switcher = (
    <div className="mx-auto mb-6 flex w-fit flex-wrap items-center justify-center gap-3">
      <span className="text-label-14 text-gray-900">When the support agent serves</span>
      {/* The size sits here, outside cn(): tailwind-merge reads text-label-14 as a color and
          drops it next to the buttons' text-gray-* classes. The buttons are equal grid
          columns, so the selected pill can slide between them with a CSS transform alone. */}
      <div
        aria-label="Customer"
        className="relative grid grid-cols-2 rounded-full bg-gray-100 p-1 text-label-14"
        data-customer={customer.id}
        role="tablist"
      >
        <span
          aria-hidden
          className="absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-background-100 shadow-(--ds-shadow-border-small) transition-transform duration-300 ease-out motion-reduce:transition-none in-data-[customer=pro]:translate-x-full"
        />
        {CUSTOMERS.map((option) => (
          <button
            aria-selected={customer.id === option.id}
            className={cn(
              "relative flex cursor-pointer items-center justify-center gap-2 rounded-full py-1 pr-1.5 pl-3 transition-colors",
              customer.id === option.id ? "text-gray-1000" : "text-gray-900 hover:text-gray-1000",
            )}
            key={option.id}
            onClick={() => setCustomer(option)}
            role="tab"
            type="button"
          >
            <span className="font-medium">{option.name}</span>
            <PlanBadge customer={option} />
          </button>
        ))}
      </div>
    </div>
  );

  const board = (
    <div className="relative">
      {/* Grid line aligned with the card header's border-b, fading out at the edges. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-12 -right-4 -left-4 h-px sm:-right-14 sm:-left-14"
        style={{
          background:
            "linear-gradient(to right, transparent, var(--ds-gray-400) 7.5%, var(--ds-gray-400) 92.5%, transparent)",
        }}
      />
      <div className="mx-auto max-w-5xl">
        <div className="relative overflow-hidden material-large">
          <div className="grid grid-cols-[270px_1fr]">
            {/* Sidebar: the files in this agent; click any to view it. */}
            <div className="border-r">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">agent/</span>
                <span className="ml-2 truncate text-gray-700 text-sm">example</span>
              </div>
              <div className="space-y-0.5 p-2">
                {items.map((item, i) => {
                  const missing = item.results?.[customer.id] === null;
                  return (
                    <button
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                        selectedIndex === i
                          ? "bg-gray-100 text-gray-1000"
                          : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                        missing && "opacity-50",
                      )}
                      key={item.name}
                      onClick={() => setSelectedIndex(i)}
                      type="button"
                    >
                      <span className={cn("min-w-0 truncate", missing && "line-through")}>
                        {item.name}
                      </span>
                      <Tag
                        active={selectedIndex === i}
                        customer={customer}
                        item={item}
                        required={i === 0}
                      />
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Code panel: fixed height so the card never reflows; the code
                area flexes to fill whatever the description leaves. */}
            <div className="flex min-h-[564px] min-w-0 flex-col">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{selected.fileName}</span>
              </div>
              <p className="border-b px-4 py-3 text-copy-14 text-gray-900">
                {selected.description}
              </p>
              <Resolution customer={customer} item={selected} />
              <div
                className={cn("grow pb-6 [&>div]:mb-0", branchHighlight)}
                data-customer={customer.id}
              >
                {selected.code}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // Mobile: the sidebar/code-panel split is cramped on a phone, so the folder becomes one
  // window of collapsible files. Only the first dynamic file starts open, and opening a file
  // closes the last one (native <details name> grouping, no script).
  const firstDynamic = items.findIndex((item) => item.results);
  const mobile = (
    <div className="overflow-hidden material-large">
      <div className="flex h-12 items-center border-b px-4">
        <span className="font-medium text-gray-1000 text-sm">agent/</span>
        <span className="ml-2 truncate text-gray-700 text-sm">example</span>
      </div>
      {items.map((item, i) => {
        const missing = item.results?.[customer.id] === null;
        return (
          <details
            className="group border-b last:border-b-0"
            key={item.name}
            name="agent-file"
            open={i === firstDynamic}
          >
            <summary className="flex h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm [&::-webkit-details-marker]:hidden">
              <IconChevronRightSmall
                aria-hidden
                className="shrink-0 text-gray-700 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                size={16}
              />
              <span
                className={cn(
                  "min-w-0 truncate group-open:font-medium",
                  missing ? "text-gray-500 line-through" : "text-gray-1000",
                )}
              >
                {item.fileName}
              </span>
              <Tag active={false} customer={customer} item={item} required={i === 0} />
            </summary>
            <p className="border-t px-4 py-3 text-copy-14 text-gray-900">{item.description}</p>
            <Resolution customer={customer} item={item} />
            <div className={cn("pb-2 [&>div]:mb-0", branchHighlight)} data-customer={customer.id}>
              {item.code}
            </div>
          </details>
        );
      })}
    </div>
  );

  // Every kind of file can be dynamic, not only the ones this example makes dynamic.
  const footnote = (
    <p className="mt-6 text-center text-copy-14 text-gray-900">
      Instructions, skills, tools, subagents, connections, and models can all be dynamic. Learn more
      about{" "}
      <PrefetchLink
        className="text-gray-1000 underline decoration-gray-alpha-400 underline-offset-4 hover:decoration-gray-1000"
        href="/docs/guides/dynamic-capabilities"
      >
        Dynamic Capabilities
      </PrefetchLink>
    </p>
  );

  return (
    <>
      {switcher}
      <div className="md:hidden">{mobile}</div>
      <div className="hidden md:block">{board}</div>
      {footnote}
    </>
  );
}
