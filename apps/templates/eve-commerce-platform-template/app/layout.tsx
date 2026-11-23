import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { applicationOrigin } from "@/lib/environment/origin";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], axes: ["opsz"], variable: "--font-inter" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(applicationOrigin()),
  title: { default: "Commerce Platform | eve", template: "%s | eve" },
  description: "A self-hosted, multi-tenant commerce platform for shopping over iMessage.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html className={`${inter.variable} ${geistMono.variable}`} lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
