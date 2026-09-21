"use client";

import { LoaderCircleIcon, SquarePenIcon } from "lucide-react";
import Link from "next/link";
import { memo, useEffect, useState } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import type { SessionHistory } from "@/lib/session-history";
import { ServerStatusDot, useServerStatus } from "./server-status";

export const SessionSidebar = memo(function SessionSidebar({
  historyEnabled = true,
  history,
  agentName = "eve-agent",
  error,
  activeSessionId,
  onRetry,
  onLoadMore,
  isLoadingMore,
  onNewChat,
  pendingSessionId,
  navigationError,
  onPrefetchSession,
  onSelectSession,
}: {
  readonly historyEnabled?: boolean;
  readonly history?: SessionHistory;
  readonly agentName?: string;
  readonly error?: string;
  readonly activeSessionId?: string;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly isLoadingMore: boolean;
  readonly onNewChat: () => void;
  readonly pendingSessionId?: string;
  readonly navigationError?: string;
  readonly onPrefetchSession: (id: string) => void;
  readonly onSelectSession: (id: string) => Promise<boolean>;
}) {
  const isDisconnected = useServerStatus() === "unavailable";
  const { isMobile, open, setOpenMobile } = useSidebar();
  const [serverAddress, setServerAddress] = useState("");

  useEffect(() => {
    setServerAddress(window.location.origin);
  }, []);

  const startNewChat = () => {
    setOpenMobile(false);
    onNewChat();
  };

  return (
    <Sidebar
      inert={!isMobile && !open ? true : undefined}
      aria-hidden={!isMobile && !open ? true : undefined}
      aria-label="Sidebar"
      collapsible={isMobile ? "offcanvas" : "none"}
      className="w-full"
    >
      <SidebarHeader className="pointer-events-none relative z-10 shrink-0 gap-0 bg-linear-to-b from-sidebar via-sidebar via-70% to-sidebar/0 p-0">
        <div className="pointer-events-auto flex h-16 shrink-0 items-center justify-between px-4">
          <Link
            className="text-xl font-medium tracking-tighter"
            href="/"
            onNavigate={startNewChat}
            scroll={false}
          >
            {agentName}
            <span className="text-muted-foreground">.</span>
          </Link>
          <SidebarTrigger
            aria-label={isMobile ? "Close sidebar" : "Collapse sidebar"}
            className="text-muted-foreground"
          />
        </div>
        <SidebarMenu className="px-3 pb-7">
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="pointer-events-auto h-8 gap-2.5 px-3 py-1 text-[13px] [&>svg]:size-3.5"
            >
              <Link href="/" onNavigate={startNewChat} scroll={false}>
                <SquarePenIcon />
                <span>New chat</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent aria-label="Recent sessions" className="-mt-8 scroll-pt-8 pt-8">
        <SidebarGroup className="px-3 py-0">
          <SidebarGroupLabel className="h-auto px-3 pb-3">Recent chats</SidebarGroupLabel>
          {navigationError && !isDisconnected ? (
            <p role="alert" className="px-3 pb-3 text-xs text-destructive">
              {navigationError}
            </p>
          ) : null}
          {isDisconnected && (!history || error) ? (
            <p role="status" className="px-3 text-xs text-muted-foreground">
              Server unavailable. Retrying automatically…
            </p>
          ) : error ? (
            <div role="status" className="px-3 text-xs leading-relaxed text-muted-foreground">
              {error}
              <Button
                className="mt-2 block px-0 text-xs"
                onClick={onRetry}
                size="sm"
                variant="link"
              >
                Try again
              </Button>
            </div>
          ) : null}
          {historyEnabled && !history && !error && !isDisconnected ? (
            <p className="px-3 text-xs text-muted-foreground">Loading chats…</p>
          ) : history?.sessions.length === 0 ? (
            <p className="px-3 text-xs leading-relaxed text-muted-foreground">
              Your conversations will appear here.
            </p>
          ) : history ? (
            <SidebarMenu className="gap-0.5">
              {history.sessions.map((session) => (
                <SidebarMenuItem key={session.id}>
                  <Tooltip delayDuration={450}>
                    <TooltipTrigger asChild>
                      <SidebarMenuButton
                        asChild
                        isActive={activeSessionId === session.id}
                        className="h-8 px-3 py-1 text-[13px] data-[active=true]:font-normal"
                      >
                        <Link
                          aria-current={activeSessionId === session.id ? "page" : undefined}
                          href={`/s/${encodeURIComponent(session.id)}`}
                          aria-busy={pendingSessionId === session.id}
                          onMouseEnter={() => onPrefetchSession(session.id)}
                          onFocus={() => onPrefetchSession(session.id)}
                          onNavigate={async (event) => {
                            event.preventDefault();
                            if (await onSelectSession(session.id)) setOpenMobile(false);
                          }}
                          scroll={false}
                        >
                          <span className="min-w-0 flex-1 truncate">{session.title}</span>
                          <span className="size-3 shrink-0" aria-hidden="true">
                            {pendingSessionId === session.id ? (
                              <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
                            ) : null}
                          </span>
                        </Link>
                      </SidebarMenuButton>
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      sideOffset={8}
                      className="rounded-md border border-border/60 bg-popover px-2.5 py-2 text-popover-foreground shadow-sm [&_svg]:hidden!"
                    >
                      <dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-[11px] leading-tight tabular-nums">
                        <dt className="text-muted-foreground">Created</dt>
                        <dd>
                          <time dateTime={session.createdAt}>
                            {formatSessionDate(session.createdAt)}
                          </time>
                        </dd>
                        <dt className="text-muted-foreground">Last turn</dt>
                        <dd>
                          {session.lastTurnAt ? (
                            <time dateTime={session.lastTurnAt}>
                              {formatSessionDate(session.lastTurnAt)}
                            </time>
                          ) : (
                            "No turns yet"
                          )}
                        </dd>
                      </dl>
                    </TooltipContent>
                  </Tooltip>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          ) : null}
          {history?.nextCursor ? (
            <Button
              variant="ghost"
              className="mt-2 h-8 w-full text-xs text-muted-foreground"
              disabled={isLoadingMore || isDisconnected}
              onClick={onLoadMore}
            >
              {isLoadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="mt-4 gap-0 border-t border-border/50 px-6 py-4">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <ServerStatusDot />
          <p className="truncate">
            {isDisconnected
              ? `${agentName} offline`
              : history?.viewer.source === "local"
                ? "Local workspace"
                : (history?.viewer.name ?? agentName)}
          </p>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={serverAddress}>
          {serverAddress}
        </p>
      </SidebarFooter>
    </Sidebar>
  );
});

function formatSessionDate(value: string) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
