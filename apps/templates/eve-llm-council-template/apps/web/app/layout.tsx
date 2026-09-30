import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "eve.dev llm council",
  description: "A four-model LLM council built with eve.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={`${GeistSans.variable} ${GeistMono.variable}`} lang="en">
      <head>
        <link href="https://vercel.com/geist/vercel-brand.css" precedence="vbg" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
