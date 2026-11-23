"use client";

import {
  Drawer,
  DrawerBackdrop,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@ui-sdk/react/drawer";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CloudIcon,
  ContactRoundIcon,
  HouseIcon,
  MenuIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { EveLockup, GitHubMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/class-names";
import { AuthenticatedAccountControl } from "./account-control";

const primaryLinks = [
  { href: "/", label: "Home", Icon: HouseIcon },
  { href: "/context", label: "Personalization", Icon: ContactRoundIcon },
  { href: "/deployment", label: "Deployment", Icon: CloudIcon },
] as const;
const settingsLink = { href: "/settings", label: "Settings", Icon: SettingsIcon } as const;

type SidebarNavigationProps = {
  readonly pathname: string;
  readonly onNavigate?: () => void;
};
type SidebarDestination = (typeof primaryLinks)[number] | typeof settingsLink;

const sidebarLinkClass =
  "type-label flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none pointer-coarse:min-h-11";
const inactiveLinkClass =
  "text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

export function AuthenticatedSidebar({ phoneNumber }: { readonly phoneNumber: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    if (!open) return;
    // Close the modal when the persistent sidebar takes over.
    const desktop = window.matchMedia("(min-width: 48rem)");
    function closeOnDesktop() {
      if (desktop.matches) setOpen(false);
    }
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open]);

  return (
    <>
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 self-start border-r border-border bg-background md:flex md:flex-col lg:w-64">
        <div className="flex h-16 shrink-0 items-center px-3">
          <BrandLink />
        </div>
        <SidebarLinks pathname={pathname} />
        <SidebarFooter pathname={pathname} phoneNumber={phoneNumber} />
      </aside>

      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3 md:hidden">
        <BrandLink />
        <Drawer open={open} onOpenChange={setOpen} side="left" closeOnOutsidePress>
          <DrawerTrigger
            render={<Button aria-label="Open navigation" size="icon-lg" variant="ghost" />}
          >
            <MenuIcon aria-hidden="true" className="size-5" />
          </DrawerTrigger>
          <DrawerBackdrop className="bg-black/40" />
          <DrawerContent
            className="flex h-dvh w-64 max-w-[calc(100vw-3rem)] flex-col border-r border-border bg-background shadow-lg outline-none"
            initialFocus="content"
          >
            <DrawerTitle className="sr-only">Navigation</DrawerTitle>
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-3">
              <BrandLink onNavigate={() => setOpen(false)} />
              <DrawerClose
                render={<Button aria-label="Close navigation" size="icon-lg" variant="ghost" />}
              >
                <XIcon aria-hidden="true" className="size-5" />
              </DrawerClose>
            </div>
            <SidebarLinks pathname={pathname} onNavigate={() => setOpen(false)} />
            <SidebarFooter
              pathname={pathname}
              phoneNumber={phoneNumber}
              onNavigate={() => setOpen(false)}
            />
          </DrawerContent>
        </Drawer>
      </header>
    </>
  );
}

function BrandLink({ onNavigate }: { readonly onNavigate?: () => void }) {
  return (
    <Link
      aria-label="evey home"
      className="inline-flex w-fit items-center rounded-md px-2 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      href="/"
      onNavigate={onNavigate}
    >
      <EveLockup />
    </Link>
  );
}

function SidebarLinks({ pathname, onNavigate }: SidebarNavigationProps) {
  return (
    <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
      <ul className="space-y-1">
        {primaryLinks.map((link) => (
          <li key={link.href}>
            <SidebarLink link={link} pathname={pathname} onNavigate={onNavigate} />
          </li>
        ))}
        <li>
          <a
            className={cn(sidebarLinkClass, inactiveLinkClass)}
            href="https://github.com/vercel/eve/tree/main/apps/templates/eve-commerce-platform-template"
            rel="noreferrer"
            target="_blank"
          >
            <GitHubMark />
            GitHub
            <span className="sr-only"> repository (opens in a new tab)</span>
            <ArrowUpRightIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0" />
          </a>
        </li>
      </ul>
    </nav>
  );
}

function SidebarLink({
  link: { href, label, Icon },
  pathname,
  onNavigate,
}: SidebarNavigationProps & {
  readonly link: SidebarDestination;
}) {
  const current = pathname === href;
  return (
    <Link
      aria-current={current ? "page" : undefined}
      className={cn(
        sidebarLinkClass,
        current ? "bg-accent text-accent-foreground" : inactiveLinkClass,
      )}
      href={href}
      onNavigate={onNavigate}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {label}
      <ChevronRightIcon aria-hidden="true" className="ml-auto size-4 shrink-0" />
    </Link>
  );
}

function SidebarFooter({
  phoneNumber,
  pathname,
  onNavigate,
}: SidebarNavigationProps & {
  readonly phoneNumber: string;
}) {
  return (
    <div className="shrink-0">
      <nav aria-label="Utilities" className="px-2.5 py-2">
        <SidebarLink link={settingsLink} pathname={pathname} onNavigate={onNavigate} />
      </nav>
      <AuthenticatedAccountControl phoneNumber={phoneNumber} />
    </div>
  );
}
