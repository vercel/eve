"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

export function ChatWorkspaceLayout({
  sidebar,
  children,
}: {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}) {
  const { open, setOpen, isMobile } = useSidebar();
  const panel = usePanelRef();
  const expandedWidth = useRef(240);
  useEffect(() => {
    // The panel group measures after layout; restore after its ResizeObserver runs.
    let restoreFrame = 0;
    const measureFrame = requestAnimationFrame(() => {
      restoreFrame = requestAnimationFrame(() => {
        if (isMobile || !open) panel.current?.collapse();
        else panel.current?.resize(expandedWidth.current);
      });
    });
    return () => {
      cancelAnimationFrame(measureFrame);
      cancelAnimationFrame(restoreFrame);
    };
  }, [isMobile, open, panel]);

  return (
    <>
      <ResizablePanelGroup
        orientation="horizontal"
        id="chat-workspace"
        onLayoutChanged={(layout, { isUserInteraction }) => {
          if (isUserInteraction && !isMobile) {
            requestAnimationFrame(() => {
              const width = panel.current?.getSize().inPixels;
              if (width && width >= 200) expandedWidth.current = width;
            });
            setOpen(layout.sessions > 0);
          }
        }}
      >
        <ResizablePanel
          id="sessions"
          panelRef={panel}
          defaultSize="240px"
          minSize="200px"
          maxSize="400px"
          collapsible
          collapsedSize="0px"
          groupResizeBehavior="preserve-pixel-size"
          className="h-full"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle
          aria-label="Resize sidebar"
          disabled={isMobile || !open}
          className={
            isMobile || !open ? "hidden" : "z-30 bg-border/40 hover:bg-border focus-visible:bg-ring"
          }
        />
        <ResizablePanel id="conversation" minSize="0px" className="relative flex h-full flex-col">
          {isMobile || !open ? (
            <SidebarTrigger
              aria-label={isMobile ? "Open sidebar" : "Expand sidebar"}
              className="absolute top-4 left-4 z-30"
            />
          ) : null}
          {children}
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}
