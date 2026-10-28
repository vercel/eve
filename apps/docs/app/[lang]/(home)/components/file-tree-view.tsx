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
}

export function FileTreeView({ items }: { items: FileTreeItem[] }) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const board = (
    <div className="overflow-hidden rounded-xl border border-gray-alpha-400 bg-background-100">
      <div className="grid grid-cols-[240px_1fr]">
        {/* Sidebar: the building blocks; click any to view it. */}
        <div className="border-r">
          <div className="flex h-12 items-center border-b px-4">
            <span className="font-medium text-gray-1000 text-sm">agent/</span>
          </div>
          <div className="space-y-0.5 p-2">
            {items.map((item, i) => (
              <button
                key={item.name}
                type="button"
                onClick={() => setSelectedIndex(i)}
                className={cn(
                  "group flex w-full cursor-pointer items-center rounded-md px-3 py-2 text-left text-sm transition-colors",
                  selectedIndex === i
                    ? "bg-gray-100 text-gray-1000"
                    : "text-gray-700 hover:bg-gray-100/60 hover:text-gray-1000",
                )}
              >
                {item.name}
                {i > 0 ? (
                  <span
                    className={cn(
                      "ml-auto font-mono text-label-12-mono!",
                      selectedIndex === i ? "text-gray-900" : "text-gray-500",
                    )}
                  >
                    optional
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>

        {/* Every file renders in the same grid cell so the panel always fits the tallest one
            and switching files never shifts the layout. */}
        <div className="grid min-h-[460px] min-w-0">
          {items.map((item, i) => (
            <div
              aria-hidden={i !== selectedIndex}
              className={cn(
                "flex min-w-0 flex-col [grid-area:1/1]",
                i !== selectedIndex && "invisible",
              )}
              key={item.name}
            >
              <div className="flex h-12 items-center border-b px-4">
                <span className="font-medium text-gray-1000 text-sm">{item.fileName}</span>
              </div>
              <p className="border-b px-4 py-3 text-gray-900 text-copy-14">{item.description}</p>
              <div className="grow pb-6 [&>div]:mb-0">{item.code}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  // Mobile: the sidebar/code-panel split is cramped on a phone, so each file
  // simply shows its code block right beneath it in a stacked list.
  const mobile = (
    <div>
      <div className="space-y-4">
        {items.map((item, i) => (
          <div key={item.name} className="overflow-hidden rounded-xl border bg-background-100">
            <div className="flex h-12 items-center border-b px-4">
              <span className="font-medium text-gray-1000 text-sm">{item.fileName}</span>
              {i > 0 ? (
                <span className="ml-auto font-mono text-gray-500 text-label-12-mono">optional</span>
              ) : null}
            </div>
            <p className="border-b px-4 py-3 text-gray-900 text-copy-14">{item.description}</p>
            <div className="pb-2 [&>div]:mb-0">{item.code}</div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="md:hidden">{mobile}</div>
      <div className="hidden md:block">{board}</div>
    </>
  );
}
