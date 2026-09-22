import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { sessionOwner } from "@/lib/session-store";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { disposablePolyfillScript } from "@/lib/disposable-polyfill";
import { cn } from "@/lib/utils";
import { ChatWorkspace } from "./_components/chat-workspace";
import "./globals.css";

const sans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

export const metadata: Metadata = {
  title: "__EVE_INIT_APP_NAME__",
  description: "A Next.js starter for eve agents with AI Elements.",
};

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const session =
    process.env.NODE_ENV === "development"
      ? null
      : await auth.api.getSession({ headers: await headers() });
  const owner = session?.user.vercelSubject ? sessionOwner(session.user)?.key : undefined;
  return (
    <html className={cn(sans.variable, mono.variable)} lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: disposablePolyfillScript }} />
      </head>
      <body>
        <TooltipProvider>
          <ChatWorkspace
            initialOwner={owner}
            localWorkspace={
              process.env.NODE_ENV === "development" &&
              !["production", "preview"].includes(process.env.VERCEL_ENV ?? "")
            }
          >
            {children}
          </ChatWorkspace>
        </TooltipProvider>
      </body>
    </html>
  );
}
