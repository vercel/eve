import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ServerStatusProvider } from "./_components/server-status";
import { disposablePolyfillScript } from "@/lib/disposable-polyfill";
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
  title: "eve Next.js Starter",
  description: "A Next.js starter for eve agents with AI Elements.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={cn(sans.variable, mono.variable)} lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: disposablePolyfillScript }} />
      </head>
      <body>
        <TooltipProvider>
          <ServerStatusProvider>{children}</ServerStatusProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
