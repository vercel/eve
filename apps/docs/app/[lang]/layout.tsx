import "../global.css";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import type { Metadata } from "next";
import { GeistdocsProvider } from "@/components/geistdocs/provider";
import { config } from "@/lib/geistdocs/config";
import { mono, sans } from "@/lib/geistdocs/fonts";
import { cn } from "@/lib/utils";

/**
 * Site-wide metadata. The `robots` block emits
 * `<meta name="robots" content="noindex, nofollow">` into every page
 * while Eve is pre-1.0 and the docs are still in flux. Flip both
 * fields to `true` (and update `app/robots.ts` + the `X-Robots-Tag`
 * header in `next.config.ts`) when we're ready to invite search
 * traffic.
 */
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

const Layout = async ({ children, params }: LayoutProps<"/[lang]">) => {
  const { lang } = await params;

  return (
    <html
      className={cn(sans.variable, mono.variable, "scroll-smooth antialiased")}
      lang={lang}
      suppressHydrationWarning
    >
      <body>
        <GeistdocsProvider basePath={config.basePath} lang={lang}>
          <Navbar config={config} />
          {children}
          <Footer config={config} />
        </GeistdocsProvider>
      </body>
    </html>
  );
};

export default Layout;
