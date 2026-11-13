import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { type ReactNode, Suspense } from "react";
import { LogoMark } from "@/components/logo-mark";
import { NavLinks, NavLinksFallback, NewChatButton } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { hasPasswordSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { logout } from "./login/actions";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "eve Agent with Python",
  description: "An eve agent with Python tools, deployed as one Vercel project with Vercel Services.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={cn(geistSans.variable, geistMono.variable)} lang="en">
      <body className="flex min-h-dvh flex-col bg-background text-foreground antialiased">
        <TooltipProvider>
          <header className="sticky top-0 z-30 h-(--header-height) border-b bg-background/80 backdrop-blur">
            <nav className="mx-auto flex h-full w-full max-w-3xl items-center gap-1 px-4">
              {/* A plain anchor: a soft navigation from a chat would keep its stale session. */}
              <a
                aria-label="eve Agent with Python"
                className="mr-2 rounded-md focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                href="/"
                title="eve Agent with Python"
              >
                <LogoMark />
              </a>
              <Suspense fallback={<NavLinksFallback />}>
                <NavLinks />
              </Suspense>
              <div className="ml-auto flex items-center gap-1">
                <Suspense fallback={null}>
                  <NewChatButton />
                </Suspense>
                <Suspense fallback={null}>
                  <SignOutButton />
                </Suspense>
              </div>
            </nav>
          </header>
          {children}
        </TooltipProvider>
      </body>
    </html>
  );
}

/** Reads the session cookie per request, so it streams in after the static header. */
async function SignOutButton() {
  if (!(await hasPasswordSession())) {
    return null;
  }
  return (
    <form action={logout}>
      <Button size="sm" type="submit" variant="ghost">
        Sign Out
      </Button>
    </form>
  );
}
