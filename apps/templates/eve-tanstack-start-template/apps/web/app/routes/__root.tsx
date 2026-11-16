import {
  createRootRoute,
  HeadContent,
  Outlet,
  redirect,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getAccessStatus } from "@/app/access";
import { TooltipProvider } from "@/components/ui/tooltip";

import fontsCss from "../fonts.css?url";
import globalsCss from "../globals.css?url";

export const Route = createRootRoute({
  /**
   * Sends visitors without chat access to `/login`, remembering where they were headed.
   *
   * @param options - The route context; `location` is the page being loaded.
   * @throws {@link redirect} To `/login` when access is `locked` or `unconfigured`.
   */
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/login") {
      return;
    }
    const status = await getAccessStatus();
    if (status === "locked" || status === "unconfigured") {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "eve TanStack Agent" },
      {
        name: "description",
        content: "A TanStack Start starter for eve agents with AI Elements.",
      },
    ],
    links: [
      { rel: "stylesheet", href: globalsCss },
      { rel: "stylesheet", href: fontsCss },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
