import type { Metadata } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const geist = Geist({ subsets: ["latin"] });

export const metadata: Metadata = {
  description: "Talk to an eve agent with GPT-Live-1.",
  title: "eve Voice Template",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className="dark" lang="en">
      <body className={`${geist.className} antialiased`}>{children}</body>
    </html>
  );
}
