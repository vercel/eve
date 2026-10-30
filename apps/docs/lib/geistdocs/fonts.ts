import { Geist_Mono as createMono } from "next/font/google";
import createLocal from "next/font/local";

// Google Fonts strips Geist's stylistic sets, so the `ss05` alternate "I" the foundation
// CSS enables needs the full font from the `geist` package.
export const sans = createLocal({
  src: "../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
});

export const mono = createMono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});
