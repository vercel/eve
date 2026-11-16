"use client";

import { TabsWithChildren as GeistTabsWithChildren } from "@vercel/geistdocs/components/tabs-with-children";
import { type ComponentProps, useCallback, useEffect, useState } from "react";

type TabsWithChildrenProps = ComponentProps<typeof GeistTabsWithChildren> & {
  /** Tab groups that share a `groupId` switch together, and the choice persists across pages. */
  groupId?: string;
};

const listeners = new Map<string, Set<(value: string) => void>>();
const storageKey = (groupId: string) => `eve-docs-tabs:${groupId}`;

// Browsers can block storage or reject writes; the tabs still switch together in memory.
function readStored(groupId: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(groupId));
  } catch {
    return null;
  }
}

function writeStored(groupId: string, value: string): void {
  try {
    window.localStorage.setItem(storageKey(groupId), value);
  } catch {}
}

function useGroupedTab(groupId: string, defaultValue: string) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    const stored = readStored(groupId);
    if (stored) setValue(stored);
    const group = listeners.get(groupId) ?? new Set();
    group.add(setValue);
    listeners.set(groupId, group);
    return () => {
      group.delete(setValue);
    };
  }, [groupId]);

  const select = useCallback(
    (next: string) => {
      writeStored(groupId, next);
      for (const listener of listeners.get(groupId) ?? []) listener(next);
    },
    [groupId],
  );

  return [value, select] as const;
}

function GroupedTabsWithChildren({
  groupId,
  ...props
}: TabsWithChildrenProps & { groupId: string }) {
  const [value, select] = useGroupedTab(groupId, props.defaultValue ?? "tab1");
  return <GeistTabsWithChildren {...props} onValueChange={select} value={value} />;
}

/** geistdocs' `TabsWithChildren`, plus an optional `groupId` that keeps related tab groups in sync. */
export function TabsWithChildren({ groupId, ...props }: TabsWithChildrenProps) {
  if (!groupId) return <GeistTabsWithChildren {...props} />;
  return <GroupedTabsWithChildren groupId={groupId} {...props} />;
}
