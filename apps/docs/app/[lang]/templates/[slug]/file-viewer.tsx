"use client";

import {
  BotIcon,
  BracesIcon,
  ChevronRightIcon,
  FileTextIcon,
  type LucideIcon,
  MessageSquareIcon,
  PlugIcon,
  SettingsIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { TemplateFile } from "@/lib/templates/data";
import { cn } from "@/lib/utils";

export interface HighlightedTemplateFile {
  code: ReactNode;
  language: TemplateFile["language"];
  relativePath: string;
}

interface FileViewerProps {
  files: HighlightedTemplateFile[];
}

interface CategoryStyle {
  icon: LucideIcon;
}

const categoryStyles: Record<string, CategoryStyle> = {
  "agent.ts": { icon: SettingsIcon },
  "instructions.md": { icon: FileTextIcon },
  channels: { icon: MessageSquareIcon },
  connections: { icon: PlugIcon },
  skills: { icon: FileTextIcon },
  tools: { icon: WrenchIcon },
  subagents: { icon: BotIcon },
  lib: { icon: BracesIcon },
};

const defaultStyle: CategoryStyle = { icon: FileTextIcon };
const categoryOrder = [
  "agent.ts",
  "instructions.md",
  "channels",
  "connections",
  "skills",
  "tools",
  "subagents",
  "lib",
];

interface FileEntry {
  file: HighlightedTemplateFile;
  label: string;
}

interface FolderNode {
  entries: FileEntry[];
  key: string;
  kind: "folder";
  style: CategoryStyle;
}

interface LeafNode {
  file: HighlightedTemplateFile;
  key: string;
  kind: "leaf";
  style: CategoryStyle;
}

type TreeNode = FolderNode | LeafNode;

const buildTree = (files: HighlightedTemplateFile[]): TreeNode[] => {
  const folders = new Map<string, FileEntry[]>();
  const leaves = new Map<string, HighlightedTemplateFile>();

  for (const sourceFile of files) {
    const parts = sourceFile.relativePath.split("/");
    if (parts[0] !== "agent" || parts.length < 2) {
      continue;
    }
    if (parts.length === 2) {
      leaves.set(parts[1], sourceFile);
      continue;
    }

    const directory = parts[1];
    const entries = folders.get(directory) ?? [];
    entries.push({ file: sourceFile, label: parts.slice(2).join("/") });
    folders.set(directory, entries);
  }

  const keys = new Set([...categoryOrder, ...leaves.keys(), ...folders.keys()]);

  return [...keys].flatMap<TreeNode>((key) => {
    const style = categoryStyles[key] ?? defaultStyle;
    const leaf = leaves.get(key);
    if (leaf) {
      return [{ file: leaf, key, kind: "leaf", style }];
    }

    const entries = folders.get(key);
    if (!entries) {
      return [];
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return [{ entries, key, kind: "folder", style }];
  });
};

export const FileViewer = ({ files }: FileViewerProps) => {
  const tree = useMemo(() => buildTree(files), [files]);
  const initialPath = files[0]?.relativePath ?? null;
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const [openFolders, setOpenFolders] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    const parts = initialPath?.split("/");
    if (parts && parts.length >= 3) {
      initial.add(parts[1]);
    }
    return initial;
  });
  const selected = files.find((sourceFile) => sourceFile.relativePath === selectedPath);

  const selectFolder = (folder: FolderNode) => {
    setOpenFolders((current) => new Set(current).add(folder.key));
    const firstFile = folder.entries[0]?.file;
    if (firstFile) {
      setSelectedPath(firstFile.relativePath);
    }
  };

  const toggleFolder = (key: string) => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="grid overflow-hidden rounded-lg border border-gray-alpha-400 bg-background-100 md:grid-cols-[200px_minmax(0,1fr)]">
      <nav
        aria-label="Template files"
        className="border-gray-alpha-400 border-b p-3 md:border-r md:border-b-0"
      >
        <p className="px-2 pb-2 text-gray-800 text-label-13-mono">agent/</p>
        <ul className="space-y-0.5">
          {tree.map((node) => {
            const Icon = node.style.icon;
            if (node.kind === "leaf") {
              const isSelected = node.file.relativePath === selectedPath;
              return (
                <li key={node.key}>
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-sm px-2 text-left font-mono text-[13px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-700 motion-reduce:transition-none md:min-h-7",
                      isSelected
                        ? "font-medium text-gray-1000"
                        : "text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000",
                    )}
                    onClick={() => setSelectedPath(node.file.relativePath)}
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-gray-900" />
                    <span className="truncate">{node.key}</span>
                  </button>
                </li>
              );
            }

            const isOpen = openFolders.has(node.key);
            const containsSelected = node.entries.some(
              (entry) => entry.file.relativePath === selectedPath,
            );
            return (
              <li key={node.key}>
                <button
                  aria-expanded={isOpen}
                  className={cn(
                    "flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-sm px-2 text-left font-mono text-[13px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-700 motion-reduce:transition-none md:min-h-7",
                    containsSelected
                      ? "text-gray-1000"
                      : "text-gray-900 hover:bg-gray-alpha-100 hover:text-gray-1000",
                  )}
                  onClick={() => (isOpen ? toggleFolder(node.key) : selectFolder(node))}
                  type="button"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3 shrink-0 text-gray-700 transition-transform",
                      isOpen ? "rotate-90" : null,
                    )}
                  />
                  <Icon aria-hidden="true" className="size-3.5 shrink-0 text-gray-900" />
                  <span className="truncate">{node.key}/</span>
                </button>
                {isOpen ? (
                  <ul className="mt-0.5 ml-[18px] space-y-0.5 border-gray-alpha-400 border-l pl-3">
                    {node.entries.map((entry) => {
                      const isSelected = entry.file.relativePath === selectedPath;
                      return (
                        <li key={entry.file.relativePath}>
                          <button
                            aria-pressed={isSelected}
                            className={cn(
                              "min-h-11 w-full touch-manipulation truncate rounded-sm px-2 text-left font-mono text-[13px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-700 motion-reduce:transition-none md:min-h-7",
                              isSelected
                                ? "font-medium text-gray-1000"
                                : "text-gray-800 hover:bg-gray-alpha-100 hover:text-gray-1000",
                            )}
                            onClick={() => setSelectedPath(entry.file.relativePath)}
                            type="button"
                          >
                            {entry.label}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="flex min-w-0 flex-col">
        <div className="flex min-h-11 items-center justify-between gap-4 border-gray-alpha-400 border-b px-4">
          <code className="truncate text-copy-13-mono text-gray-1000">
            {selected?.relativePath ?? ""}
          </code>
          <span className="shrink-0 rounded-sm bg-gray-alpha-200 px-2 py-1 text-gray-900 text-label-12-mono">
            {selected?.language ?? ""}
          </span>
        </div>
        <div className="max-h-[560px] min-h-80 overflow-auto md:min-h-[420px] [&>div]:mb-0">
          {selected?.code ?? null}
        </div>
      </div>
    </div>
  );
};
