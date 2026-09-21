"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  readWorkspacePane,
  type WorkspacePane,
  type WorkspacePanePayloads,
} from "@/lib/workspace-pane";

export interface WorkspacePaneController {
  readonly pane?: WorkspacePane;
  readonly openPane: (pane: WorkspacePane) => void;
  readonly closePane: () => void;
}
export const WorkspacePaneContext = createContext<WorkspacePaneController | null>(null);
export function useWorkspacePane() {
  const value = useContext(WorkspacePaneContext);
  if (!value) throw new Error("Pane controls require a workspace.");
  return value;
}

export function useWorkspacePaneController(
  owner?: string,
  parent?: string,
): WorkspacePaneController {
  const scope =
    owner && parent ? `eve:web:workspace-pane:v1:${JSON.stringify([owner, parent])}` : undefined;
  const [selection, setSelection] = useState<{ scope: string; pane: WorkspacePane }>();
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!scope || !parent) return;
    try {
      const pane = readWorkspacePane(localStorage.getItem(scope), parent);
      setSelection(pane ? { scope, pane } : undefined);
    } catch {
      setSelection(undefined);
    }
  }, [scope, parent]);
  const openPane = useCallback(
    (pane: WorkspacePane) => {
      if (!scope) return;
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setSelection({ scope, pane });
      try {
        localStorage.setItem(scope, JSON.stringify({ ...pane, rootSessionId: parent }));
      } catch {
        /* Memory still works. */
      }
    },
    [scope, parent],
  );
  const closePane = useCallback(() => {
    setSelection(undefined);
    if (scope)
      try {
        localStorage.removeItem(scope);
      } catch {
        /* Memory still works. */
      }
    opener.current?.focus({ preventScroll: true });
  }, [scope]);
  return { pane: selection?.scope === scope ? selection?.pane : undefined, openPane, closePane };
}

export type WorkspacePaneRegistry = {
  [K in keyof WorkspacePanePayloads]: (
    payload: WorkspacePanePayloads[K],
    close: () => void,
  ) => ReactNode;
};
/** The layout owns sizing; registered views own their content and state. */
export function WorkspacePaneHost({ registry }: { readonly registry: WorkspacePaneRegistry }) {
  const { pane, closePane } = useWorkspacePane();
  return pane ? renderPane(pane, registry, closePane) : null;
}

function renderPane<K extends keyof WorkspacePanePayloads>(
  pane: { kind: K; payload: WorkspacePanePayloads[K] },
  registry: WorkspacePaneRegistry,
  close: () => void,
) {
  return registry[pane.kind](pane.payload, close);
}
