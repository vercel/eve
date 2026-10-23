import "../global.css";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import type { Metadata, Viewport } from "next";
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

// iOS Safari zooms into inputs with text smaller than 16px on focus, such as
// the Ask AI textarea. It still allows pinch zoom with a maximum scale set.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
