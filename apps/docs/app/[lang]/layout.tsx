import "../global.css";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import type { Metadata } from "next";
import { GeistdocsProvider } from "@/components/geistdocs/provider";
import { config } from "@/lib/geistdocs/config";
import { mono, sans } from "@/lib/geistdocs/fonts";
import { staticOgImage } from "@/lib/geistdocs/og";
import { supportedLanguages } from "@/lib/geistdocs/languages";
import { rootTitleMetadata } from "@/lib/geistdocs/metadata-title";
import { getRootLang } from "@/lib/geistdocs/root-params";
import { getSiteOrigin } from "@/lib/geistdocs/url";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  metadataBase: new URL(getSiteOrigin()),
  title: rootTitleMetadata,
  openGraph: {
    images: [staticOgImage],
  },
  robots: {
    index: true,
    follow: true,
  },
  twitter: {
    card: "summary_large_image",
    images: [staticOgImage],
  },
};

export const generateStaticParams = () => supportedLanguages.map((lang) => ({ lang }));

const Layout = async ({ children }: LayoutProps<"/[lang]">) => {
  const lang = await getRootLang();

  return (
    <html
      className={cn(sans.variable, mono.variable, "antialiased")}
      lang={lang}
      suppressHydrationWarning
    >
      <body>
        <GeistdocsProvider basePath={config.basePath} lang={lang}>
          <Navbar config={config} />
          {children}
          <Footer />
        </GeistdocsProvider>
      </body>
    </html>
  );
};

export default Layout;
