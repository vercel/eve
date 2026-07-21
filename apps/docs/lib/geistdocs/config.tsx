import { defineConfig, type GeistdocsNavbarOssProduct } from "@vercel/geistdocs/config";
import {
  agent,
  basePath,
  eveAgent,
  github,
  Logo,
  nav,
  prompt,
  siteId,
  suggestions,
  title,
  translations,
} from "@/geistdocs";

// geistdocs' default OSS products, minus eve (this site).
const navbarOssProducts: GeistdocsNavbarOssProduct[] = [
  { href: "https://nextjs.org/", label: "Next.js", section: "Frameworks" },
  { href: "https://svelte.dev/", label: "Svelte", section: "Frameworks" },
  { href: "https://nuxt.com/", label: "Nuxt", section: "Frameworks" },
  { href: "https://nitro.build/", label: "Nitro", section: "Frameworks" },
  { href: "https://ai-sdk.dev/", label: "AI SDK", section: "SDKs" },
  { href: "https://chat-sdk.dev/", label: "Chat SDK", section: "SDKs" },
  { href: "https://flags-sdk.dev/", label: "Flags SDK", section: "SDKs" },
  { href: "https://workflow-sdk.dev/", label: "Workflow SDK", section: "SDKs" },
  { href: "https://turborepo.dev/", label: "Turborepo", section: "Other" },
  { href: "https://ui.shadcn.com/", label: "Shadcn", section: "Other" },
  { href: "https://swr.vercel.app/", label: "SWR", section: "Other" },
  { href: "https://justbash.dev/", label: "just-bash", section: "Other" },
];

export const config = defineConfig({
  title,
  agent,
  defaultLanguage: "en",
  logo: <Logo />,
  github,
  nav,
  navbarOssProducts,
  basePath,
  siteId,
  translations,
  // Built-in edit link hardcodes `/edit/` and a `content/docs/` prefix; we
  // render our own `/blob/` link instead (see EditOnGithubAction).
  pageActions: { editSource: false },
  content: [{ id: "docs", label: "Docs", dir: "docs", route: "/docs" }],
  ai: {
    eveAgent,
    // Used only if eveAgent is removed and chat falls back to gateway mode.
    prompt,
    suggestions,
  },
});
