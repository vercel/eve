"use client";

import {
  HistoryIcon,
  KeyRoundIcon,
  ListTodoIcon,
  MessageSquareIcon,
  PanelsTopLeftIcon,
  UserRoundIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "@web/components/ui/sidebar";

const navigation = [
  { href: "/", icon: PanelsTopLeftIcon, id: "workspace", label: "Workspace" },
  { href: "/vault", icon: KeyRoundIcon, id: "vault", label: "Vault" },
  { href: "/link", icon: WalletIcon, id: "link", label: "Link wallet" },
  {
    href: "/personal-info",
    icon: UserRoundIcon,
    id: "personal-info",
    label: "Personal info",
  },
  { href: "/chat", icon: MessageSquareIcon, id: "chat", label: "Chat" },
  {
    href: "/chat/history",
    icon: HistoryIcon,
    id: "history",
    label: "All chats",
  },
  { href: "/tasks", icon: ListTodoIcon, id: "tasks", label: "Tasks" },
] as const;

export function AuthenticatedNavigation() {
  const active = activeRoute(usePathname());

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <nav aria-label="Primary">
          <SidebarMenu>
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={active === item.id}
                    render={<Link href={item.href} />}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </nav>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function AuthenticatedMobileHeader() {
  const active = activeRoute(usePathname());
  const label = navigation.find((item) => item.id === active)?.label;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4 md:hidden">
      <SidebarTrigger />
      <span className="type-label">{label}</span>
    </header>
  );
}

function activeRoute(pathname: string) {
  if (pathname === "/") return "workspace";
  if (pathname.startsWith("/vault")) return "vault";
  if (pathname === "/link") return "link";
  if (pathname.startsWith("/personal-info")) return "personal-info";
  if (pathname.startsWith("/chat/history")) return "history";
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/tasks")) return "tasks";
  return undefined;
}
