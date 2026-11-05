"use client";

import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

interface FileTreeItem {
  /** Category name (unused by this layout). */
  label: string;
  /** File/folder name shown in the IDE file tree. */
  name: string;
  /** Full path shown in the code panel header. */
  fileName: string;
  /** Short, what-this-file-does line shown above the code. */
  description: string;
  /** Category icon (unused by this layout). */
  navIcon: ReactNode;
  /** Pre-highlighted code, rendered on the server through the geistdocs CodeBlock. */
  code: ReactNode;
  /** For a dynamic file: what it resolves to for each example tenant. */
  tenants?: { name: string; plan: string; result: string }[];
}

const MODES = [
  { id: "folder", label: "Simple agent (files)" },
  { id: "tenants", label: "Multi-tenant agent (dynamic)" },
] as const;

type Mode = (typeof MODES)[number]["id"];

/** The tag beside a file: authored files past the first are optional, dynamic ones say so. */
function tagFor(mode: Mode, index: number) {
  if (mode === "tenants") return "dynamic";
  return index > 0 ? "optional" : null;
}

/** What a dynamic file resolved to for each tenant, under its description. */
function Tenants({ tenants }: { tenants: NonNullable<FileTreeItem["tenants"]> }) {
  return (
    <dl className="m-0 grid grid-cols-[auto_auto_1fr] items-center gap-x-4 gap-y-2 border-b px-4 py-3 text-copy-14">
      {tenants.map((tenant) => (
        <div className="contents" key={tenant.name}>
          <dt className="font-medium text-gray-1000">{tenant.name}</dt>
          <dd className="m-0 font-mono text-gray-700 text-label-12-mono">{tenant.plan}</dd>
          <dd className="m-0 truncate text-gray-900">{tenant.result}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FileTreeView({
  folderItems,
  tenantItems,
}: {
  folderItems: FileTreeItem[];
  tenantItems: FileTreeItem[];
}) {
  const [mode, setMode] = useState<Mode>("folder");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const items = mode === "folder" ? folderItems : tenantItems;
  const selected = items[selectedIndex] ?? items[0];

  const tabs = (
    <div
      aria-label="Agent type"
      className="mx-auto mb-6 flex w-fit gap-1 rounded-full bg-gray-100 p-1"
      role="tablist"
    >
      {MODES.map(({ id, label }) => (
        <button
          aria-selected={mode === id}
          className={cn(
            "cursor-pointer rounded-full px-4 py-1.5 text-label-14 transition-colors",
            mode === id
              ? "bg-background-100 text-gray-1000 shadow-(--ds-shadow-border-small)"
              : "text-gray-900 hover:text-gray-1000",
          )}
          key={id}
          onClick={() => {
            setMode(id);
            setSelectedIndex(0);
          }}
          role="tab"
          type="button"
        >
          {label}
        </button>
      ))}
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
        <div className="relative overflow-hidden rounded-t-xl border bg-background-100">
          <div className="grid grid-cols-[260px_1fr]">
            {/* Sidebar — the files in this agent; click any to view it. */}
            <div className="border-r">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">agent/</span>
              </div>
              <div className="space-y-0.5 p-2">
                {items.map((item, i) => {
                  const tag = tagFor(mode, i);
                  return (
                    <button
                      key={item.name}
                      type="button"
                      onClick={() => setSelectedIndex(i)}
                      className={cn(
                        "group flex w-full cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                        selectedIndex === i
                          ? "bg-gray-100 text-gray-1000"
                          : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                      )}
                    >
                      <span className="min-w-0 truncate">{item.name}</span>
                      {tag ? (
                        <span
                          className={cn(
                            "ml-auto shrink-0 font-mono text-label-12-mono!",
                            selectedIndex === i ? "text-gray-900" : "text-gray-500",
                          )}
                        >
                          {tag}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Code panel — fixed height so the card never reflows; the code
                area flexes to fill whatever the (content-hugging) description leaves. */}
            <div className="flex min-h-[564px] min-w-0 flex-col">
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{selected.fileName}</span>
              </div>
              <p className="border-b px-4 py-3 text-copy-14 text-gray-900">
                {selected.description}
              </p>
              {selected.tenants ? <Tenants tenants={selected.tenants} /> : null}
              <div className="grow pb-6 [&>div]:mb-0">{selected.code}</div>
            </div>
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -bottom-1 -mx-2 h-12 bg-linear-to-t from-background-200 to-transparent"
      />
    </div>
  );

  // Mobile: the sidebar/code-panel split is cramped on a phone, so each file
  // simply shows its code block right beneath it in a stacked list.
  const mobile = (
    <div className="space-y-4">
      {items.map((item, i) => (
        <div key={item.name} className="overflow-hidden rounded-xl border bg-background-100">
          <div className="flex h-12 items-center border-b px-4">
            <span className="min-w-0 truncate font-medium text-gray-1000 text-sm">
              {item.fileName}
            </span>
            {tagFor(mode, i) ? (
              <span className="ml-auto shrink-0 font-mono text-gray-500 text-label-12-mono">
                {tagFor(mode, i)}
              </span>
            ) : null}
          </div>
          <p className="border-b px-4 py-3 text-copy-14 text-gray-900">{item.description}</p>
          {item.tenants ? <Tenants tenants={item.tenants} /> : null}
          <div className="pb-2 [&>div]:mb-0">{item.code}</div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      {tabs}
      <div className="md:hidden">{mobile}</div>
      <div className="hidden md:block">{board}</div>
    </>
  );
}
