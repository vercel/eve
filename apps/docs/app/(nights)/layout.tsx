import "../global.css";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import type { Metadata } from "next";
import { mono, sans } from "@/lib/geistdocs/fonts";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteOrigin()),
};

const NightsLayout = ({ children }: { children: React.ReactNode }) => (
  <html className={cn(sans.variable, mono.variable, "antialiased")} lang="en">
    <body>
      {children}
      <Analytics />
      <SpeedInsights />
    </body>
  </html>
);

export default NightsLayout;
