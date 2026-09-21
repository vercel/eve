"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";

export function ChatWorkspaceLayout({
  sidebar,
  children,
  detail,
  onCloseDetail,
}: {
  readonly detail?: ReactNode;
  readonly onCloseDetail: () => void;
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}) {
  const { open, setOpen, isMobile } = useSidebar();
  const panel = usePanelRef();
  const expandedWidth = useRef(240);
  const [detailWidth, setDetailWidth] = useState(40);
  useEffect(() => {
    try {
      const width = Number(localStorage.getItem("eve:web:detail-width:v1"));
      if (width >= 20 && width <= 70) setDetailWidth(width);
    } catch {
      /* Layout remains usable when storage is disabled. */
    }
  }, []);

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
            if (layout.detail > 0) {
              setDetailWidth(layout.detail);
              try {
                localStorage.setItem("eve:web:detail-width:v1", String(layout.detail));
              } catch {
                /* Use the in-memory width. */
              }
            }
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
        {detail && !isMobile ? (
          <>
            <ResizableHandle aria-label="Resize detail pane" className="bg-border/50" />
            <ResizablePanel
              id="detail"
              defaultSize={`${detailWidth}%`}
              minSize="280px"
              maxSize="70%"
            >
              {detail}
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      {isMobile ? (
        <Sheet
          open={!!detail}
          onOpenChange={(open) => {
            if (!open) onCloseDetail();
          }}
        >
          <SheetContent
            showCloseButton={false}
            aria-describedby={undefined}
            className="w-full gap-0 sm:max-w-none"
          >
            <SheetTitle className="sr-only">Workspace detail</SheetTitle>
            {detail}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
