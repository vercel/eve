"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Chat" },
  { href: "/tasks", label: "Tasks" },
  { href: "/backend", label: "Backend" },
  { href: "/api-docs", label: "API" },
] as const;

function isChatRoute(pathname: string) {
  return pathname === "/" || pathname === "/s" || pathname.startsWith("/s/");
}

export function NavLinks() {
  const pathname = usePathname() ?? "/";
  // Signed-out visitors can't reach any of these pages, so show only the logo.
  if (pathname === "/login") {
    return null;
  }
  return <Links pathname={pathname} />;
}

/**
 * The Suspense fallback for {@link NavLinks}: the same links with no active page, shown in
 * the static shell of dynamic routes, where the pathname is only known per request.
 */
export function NavLinksFallback() {
  return <Links pathname={null} />;
}

function Links({ pathname }: { readonly pathname: string | null }) {
  // An unknown pathname might be a chat route, so treat it as one for the hard navigation.
  const onChat = pathname === null || isChatRoute(pathname);

  return (
    <div className="flex items-center gap-1">
      {links.map(({ href, label }) => {
        const active =
          pathname !== null && (href === "/" ? onChat : pathname.startsWith(href));
        const props = {
          "aria-current": active ? ("page" as const) : undefined,
          className: cn(
            "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
            active && "bg-muted text-foreground",
          ),
        };
        // Chat URLs are rewritten to /s/<id> via history.replaceState without a
        // remount, so a soft navigation would keep stale chat state. Hard-navigate.
        return href === "/" && onChat ? (
          <a {...props} href="/" key={href}>
            {label}
          </a>
        ) : (
          <Link {...props} href={href} key={href}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}

export function NewChatButton() {
  const pathname = usePathname() ?? "/";
  if (!pathname.startsWith("/s/")) {
    return null;
  }

  return (
    <Button onClick={() => window.location.assign("/s")} size="sm" type="button" variant="ghost">
      <PlusIcon />
      <span className="max-sm:sr-only">New chat</span>
    </Button>
  );
}
